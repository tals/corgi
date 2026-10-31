/* Benchmark-only Linux PTY actor. Borrowed terminals/FDs; no production policy. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <pty.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define MAX_LANES 64
#define QUEUE 8192
struct lane {
    pthread_mutex_t mutex;
    void *terminal;
    int fd, hungup, armed;
    uint32_t interest;
    uint64_t reads, bytes, feeds, again, services;
};
struct actor {
    void *library;
    void (*feed)(void *, const void *, size_t);
    size_t (*pending)(void *);
    void (*flush)(void *);
    struct lane lanes[MAX_LANES];
    unsigned count, initialized, oneshot;
    int epoll, control, notify, running, notify_armed;
    pthread_t thread;
    atomic_int stop, error, tid;
    _Atomic uint64_t dirty, mask, notifications, sends, notification_bytes, notification_again, completed_cpu;
    _Atomic uint64_t controls;
    _Atomic uint64_t waits, ready_events;
    uint64_t queue[QUEUE];
    size_t first, length, partial;
    unsigned char scratch[65536];
};
static uint64_t clock_ns(clockid_t clock) {
    struct timespec t;
    if (clock_gettime(clock, &t)) return 0;
    return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}
uint64_t actor_now_ns(void) { return clock_ns(CLOCK_MONOTONIC); }
uint64_t actor_main_cpu_ns(void) { return clock_ns(CLOCK_THREAD_CPUTIME_ID); }
static uint64_t thread_cpu(pthread_t thread) {
    clockid_t clock;
    return pthread_getcpuclockid(thread, &clock) ? 0 : clock_ns(clock);
}
static void fail(struct actor *a, int error) {
    int expected = 0;
    atomic_compare_exchange_strong(&a->error, &expected, error);
    atomic_store(&a->stop, 1);
}
void actor_kick(void *context) {
    struct actor *a = context;
    uint64_t one = 1;
    while (write(a->control, &one, sizeof(one)) < 0) {
        if (errno == EINTR) continue;
        if (errno != EAGAIN) fail(a, errno);
        break;
    }
}
/* Called only by the worker, with this lane's mutex held. Default one-shot
 * mode preserves one rearm syscall per service for the ownership comparison. */
static void interests(struct actor *a, unsigned index) {
    struct lane *l = &a->lanes[index];
    uint32_t wanted = l->hungup ? 0 : EPOLLIN | (a->pending(l->terminal) ? EPOLLOUT : 0);
    if (wanted == l->interest && (!wanted || l->armed)) return;
#ifdef ACTOR_POLL
    l->interest = wanted; l->armed = wanted != 0;
#else
    struct epoll_event event = {.events = wanted | (a->oneshot ? EPOLLONESHOT : 0), .data.u32 = index + 1};
    int operation = wanted ? (l->interest ? EPOLL_CTL_MOD : EPOLL_CTL_ADD) : EPOLL_CTL_DEL;
    atomic_fetch_add(&a->controls, 1);
    if (epoll_ctl(a->epoll, operation, l->fd, wanted ? &event : NULL)) fail(a, errno);
    else { l->interest = wanted; l->armed = wanted != 0; }
#endif
}
static void notification_interest(struct actor *a, int wanted) {
    if (a->notify_armed == wanted) return;
#ifdef ACTOR_POLL
    a->notify_armed = wanted;
#else
    struct epoll_event event = {.events = EPOLLOUT, .data.u32 = UINT32_MAX};
    if (epoll_ctl(a->epoll, wanted ? EPOLL_CTL_ADD : EPOLL_CTL_DEL, a->notify, wanted ? &event : NULL)) fail(a, errno);
    else a->notify_armed = wanted;
#endif
}
/* Fixed registrations are owned until pause/join in both benchmark backends. */
static int wait_events(struct actor *a, struct epoll_event *events) {
    atomic_fetch_add(&a->waits, 1);
#ifdef ACTOR_POLL
    struct pollfd fds[MAX_LANES + 2];
    fds[0] = (struct pollfd){.fd = a->control, .events = POLLIN};
    for (unsigned i = 0; i < a->count; i++) {
        struct lane *l = &a->lanes[i];
        fds[i + 1] = (struct pollfd){.fd = l->interest ? l->fd : -1,
            .events = (l->interest & EPOLLIN ? POLLIN : 0) | (l->interest & EPOLLOUT ? POLLOUT : 0)};
    }
    unsigned slots = a->count + 1;
    if (a->notify_armed) fds[slots++] = (struct pollfd){.fd = a->notify, .events = POLLOUT};
    int count = poll(fds, slots, -1);
    if (count < 0) return count;
    count = 0;
    for (unsigned i = 0; i < slots; i++) {
        short ready = fds[i].revents;
        if (!ready) continue;
        events[count++] = (struct epoll_event){
            .events = (ready & POLLIN ? EPOLLIN : 0) | (ready & POLLOUT ? EPOLLOUT : 0) |
                (ready & POLLHUP ? EPOLLHUP : 0) | (ready & (POLLERR | POLLNVAL) ? EPOLLERR : 0),
            .data.u32 = i <= a->count ? i : UINT32_MAX};
    }
#else
    int count = epoll_wait(a->epoll, events, MAX_LANES + 2, -1);
#endif
    if (count > 0) atomic_fetch_add(&a->ready_events, (uint64_t)count);
    return count;
}
static void flush_notifications(struct actor *a) {
    while (a->length) {
        size_t contiguous = QUEUE - a->first;
        if (contiguous > a->length) contiguous = a->length;
        const char *data = (const char *)&a->queue[a->first] + a->partial;
        size_t bytes = contiguous * 8 - a->partial;
        ssize_t sent = send(a->notify, data, bytes, MSG_NOSIGNAL);
        atomic_fetch_add(&a->sends, 1);
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            atomic_fetch_add(&a->notification_again, 1);
            notification_interest(a, 1);
            return;
        }
        if (sent <= 0) { fail(a, sent < 0 ? errno : EIO); return; }
        atomic_fetch_add(&a->notification_bytes, (uint64_t)sent);
        size_t used = a->partial + (size_t)sent;
        a->first = (a->first + used / 8) % QUEUE;
        a->length -= used / 8;
        a->partial = used % 8;
    }
    notification_interest(a, 0);
}
static void notify(struct actor *a, unsigned index) {
    uint64_t bit = UINT64_C(1) << index;
    /* Store dirty before enqueueing. An exchange racing this store either sees
     * it or leaves it for the later queued wake/regular maintenance receipt. */
    atomic_fetch_or(&a->dirty, bit);
    if (!(atomic_load(&a->mask) & bit)) return;
    if (a->length == QUEUE) { fail(a, ENOBUFS); return; }
    a->queue[(a->first + a->length++) % QUEUE] = bit;
    atomic_fetch_add(&a->notifications, 1);
}
static void service(struct actor *a, unsigned index, uint32_t events) {
    struct lane *l = &a->lanes[index];
    pthread_mutex_lock(&l->mutex);
    if (atomic_load(&a->stop)) { pthread_mutex_unlock(&l->mutex); return; }
    if (a->oneshot) l->armed = 0;
    l->services++;
    if (events & (EPOLLIN | EPOLLHUP | EPOLLERR)) {
        for (unsigned i = 0; i < 8 && !atomic_load(&a->stop); i++) {
            ssize_t count = read(l->fd, a->scratch, sizeof(a->scratch));
            l->reads++;
            if (count > 0) {
                /* Even if stop raced read(), these consumed bytes must be fed. */
                a->feed(l->terminal, a->scratch, (size_t)count);
                l->bytes += (uint64_t)count;
                l->feeds++;
            } else if (count < 0 && errno == EINTR) {
                continue;
            } else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                l->again++;
                break;
            } else {
                l->hungup = 1;
                if (count < 0 && errno != EIO) fail(a, errno);
                break;
            }
        }
    }
    /* Feed may have queued protocol replies. User input uses this same queue. */
    a->flush(l->terminal);
    interests(a, index);
    pthread_mutex_unlock(&l->mutex);
    notify(a, index);
}
static void *run_actor(void *context) {
    struct actor *a = context;
    pthread_setname_np(pthread_self(), "pty-actor");
    atomic_store(&a->tid, (int)syscall(SYS_gettid));
    for (unsigned i = 0; i < a->count; i++) {
        pthread_mutex_lock(&a->lanes[i].mutex);
        interests(a, i);
        pthread_mutex_unlock(&a->lanes[i].mutex);
    }
    /* A pause can leave queued receipts after the control wake was consumed.
     * Restart must publish them without waiting for unrelated PTY activity. */
    if (!atomic_load(&a->stop)) flush_notifications(a);
    struct epoll_event events[MAX_LANES + 2];
    while (!atomic_load(&a->stop)) {
        int count = wait_events(a, events);
        if (count < 0) { if (errno == EINTR) continue; fail(a, errno); break; }
        for (int i = 0; i < count && !atomic_load(&a->stop); i++) {
            uint32_t token = events[i].data.u32;
            if (token == 0) {
                uint64_t value;
                while (read(a->control, &value, sizeof(value)) < 0 && errno == EINTR) {}
                for (unsigned lane = 0; lane < a->count && !atomic_load(&a->stop); lane++) {
                    pthread_mutex_lock(&a->lanes[lane].mutex);
                    interests(a, lane);
                    pthread_mutex_unlock(&a->lanes[lane].mutex);
                }
            } else if (token != UINT32_MAX) service(a, token - 1, events[i].events);
        }
        if (!atomic_load(&a->stop)) flush_notifications(a);
    }
    atomic_fetch_add(&a->completed_cpu, clock_ns(CLOCK_THREAD_CPUTIME_ID));
    return NULL;
}
void actor_pause_join(void *context) {
    struct actor *a = context;
    if (!a || !a->running) return;
    atomic_store(&a->stop, 1);
    actor_kick(a);
    pthread_join(a->thread, NULL);
    a->running = 0;
    /* epoll_wait may have consumed one-shot receipts just before stop. Rearm
     * every registration on restart, including receipts not yet serviced. */
    if (a->oneshot) for (unsigned i = 0; i < a->count; i++) a->lanes[i].armed = 0;
}
void actor_free(void *context) {
    struct actor *a = context;
    if (!a) return;
    actor_pause_join(a);
    for (unsigned i = 0; i < a->initialized; i++) pthread_mutex_destroy(&a->lanes[i].mutex);
    if (a->epoll >= 0) close(a->epoll);
    if (a->control >= 0) close(a->control);
    if (a->notify >= 0) close(a->notify);
    if (a->library) dlclose(a->library);
    free(a);
}
void *actor_new(const char *library, void *const *terminals, const int *fds, unsigned count, int *receiver, int oneshot) {
    if (!count || count > MAX_LANES) return NULL;
#ifdef ACTOR_POLL
    if (oneshot) { errno = EINVAL; return NULL; }
#endif
    struct actor *a = calloc(1, sizeof(*a));
    if (!a) return NULL;
    a->epoll = a->control = a->notify = -1;
    a->count = count;
    a->oneshot = oneshot != 0;
    a->library = dlopen(library, RTLD_NOW | RTLD_LOCAL);
    if (!a->library) goto failed;
    *(void **)&a->feed = dlsym(a->library, "terminal_feed");
    *(void **)&a->pending = dlsym(a->library, "terminal_pending");
    *(void **)&a->flush = dlsym(a->library, "terminal_flush");
    if (!a->feed || !a->pending || !a->flush) goto failed;
    a->control = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
    if (a->control < 0) goto failed;
#ifndef ACTOR_POLL
    a->epoll = epoll_create1(EPOLL_CLOEXEC);
    if (a->epoll < 0) goto failed;
    struct epoll_event event = {.events = EPOLLIN, .data.u32 = 0};
    if (epoll_ctl(a->epoll, EPOLL_CTL_ADD, a->control, &event)) goto failed;
#endif
    for (unsigned i = 0; i < count; i++) {
        int flags = fcntl(fds[i], F_GETFL);
        if (!terminals[i] || flags < 0 || !(flags & O_NONBLOCK)) goto failed;
        if (pthread_mutex_init(&a->lanes[i].mutex, NULL)) goto failed;
        a->initialized++;
        a->lanes[i].terminal = terminals[i];
        a->lanes[i].fd = fds[i];
    }
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair)) goto failed;
    *receiver = pair[0];
    a->notify = pair[1];
    atomic_store(&a->mask, UINT64_MAX);
    return a;
failed:
    actor_free(a);
    return NULL;
}
int actor_start(void *context) {
    struct actor *a = context;
    if (a->running || atomic_load(&a->error)) return EINVAL;
    atomic_store(&a->stop, 0);
    int error = pthread_create(&a->thread, NULL, run_actor, a);
    if (!error) a->running = 1;
    return error;
}
void actor_lock(void *context, unsigned lane) { pthread_mutex_lock(&((struct actor *)context)->lanes[lane].mutex); }
void actor_unlock(void *context, unsigned lane) { pthread_mutex_unlock(&((struct actor *)context)->lanes[lane].mutex); }
void actor_notify_mask(void *context, uint64_t mask) { atomic_store(&((struct actor *)context)->mask, mask); }
uint64_t actor_take_dirty(void *context) { return atomic_exchange(&((struct actor *)context)->dirty, 0); }
/* Verification-only injection: no live worker, no PTY bytes, empty queue.
 * Leave a partial record on the socket and no control wake for restart. */
int actor_fixture_notifications(void *context, unsigned count) {
    struct actor *a = context;
    if (a->running || a->length || a->partial || !count || count > QUEUE || !(atomic_load(&a->mask) & 1)) return EINVAL;
    uint64_t wake;
    for (;;) {
        ssize_t got = read(a->control, &wake, sizeof(wake));
        if (got == (ssize_t)sizeof(wake) || (got < 0 && errno == EINTR)) continue;
        if (got < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
        return got < 0 ? errno : EIO;
    }
    int capacity = 1024;
    if (setsockopt(a->notify, SOL_SOCKET, SO_SNDBUF, &capacity, sizeof(capacity))) return errno;
    for (unsigned i = 0; i < count; i++) notify(a, 0);
    ssize_t sent;
    do { sent = send(a->notify, &a->queue[a->first], 3, MSG_NOSIGNAL); } while (sent < 0 && errno == EINTR);
    atomic_fetch_add(&a->sends, 1);
    if (sent != 3) return sent < 0 ? errno : EIO;
    a->partial = 3;
    atomic_fetch_add(&a->notification_bytes, 3);
    return 0;
}
/* Caller holds the lane lock. */
uint64_t actor_fed(void *context, unsigned lane) { return ((struct actor *)context)->lanes[lane].bytes; }
void actor_stats(void *context, uint64_t *out) {
    struct actor *a = context;
    memset(out, 0, 14 * sizeof(*out));
    for (unsigned i = 0; i < a->count; i++) {
        struct lane *l = &a->lanes[i];
        pthread_mutex_lock(&l->mutex);
        out[0] += l->reads; out[1] += l->bytes; out[2] += l->feeds;
        out[3] += l->again; out[4] += l->services;
        pthread_mutex_unlock(&l->mutex);
    }
    out[5] = atomic_load(&a->notifications);
    out[6] = atomic_load(&a->sends);
    out[7] = atomic_load(&a->notification_bytes);
    out[8] = atomic_load(&a->notification_again);
    out[9] = atomic_load(&a->error);
    out[10] = atomic_load(&a->completed_cpu) + (a->running ? thread_cpu(a->thread) : 0);
    out[11] = atomic_load(&a->tid);
    out[12] = atomic_load(&a->dirty);
    out[13] = atomic_load(&a->controls);
}
void actor_wait_stats(void *context, uint64_t *out) {
    struct actor *a = context;
    out[0] = atomic_load(&a->waits); out[1] = atomic_load(&a->ready_events);
#ifdef ACTOR_POLL
    out[2] = 1;
#else
    out[2] = 0;
#endif
}

/* Same paced real-PTY producer in every variant; separate CPU accounting. */
int actor_pty(int *fds) {
    if (openpty(&fds[0], &fds[1], NULL, NULL, NULL)) return -errno;
    struct termios raw;
    if (tcgetattr(fds[1], &raw)) goto bad;
    cfmakeraw(&raw);
    if (tcsetattr(fds[1], TCSANOW, &raw)) goto bad;
    for (int i = 0; i < 2; i++)
        if (fcntl(fds[i], F_SETFL, fcntl(fds[i], F_GETFL) | O_NONBLOCK) || fcntl(fds[i], F_SETFD, FD_CLOEXEC)) goto bad;
    return 0;
bad:;
    int error = errno;
    close(fds[0]); close(fds[1]);
    return -error;
}
struct producer {
    pthread_t thread;
    int fds[MAX_LANES];
    unsigned lanes, records, size, stagger, fragment, reverse_cap;
    const unsigned char *bytes;
    unsigned char *reverse;
    uint64_t *write_times;
    _Atomic uint64_t written[MAX_LANES], received[MAX_LANES], completed_cpu;
    atomic_int stop, done, error, tid, receive;
    uint64_t start;
};
static void receive_input(struct producer *p) {
    if (!atomic_load(&p->receive)) return;
    for (unsigned i = 0; i < p->lanes; i++) {
        size_t offset = atomic_load(&p->received[i]);
        if (offset == p->reverse_cap) { atomic_store(&p->error, ENOBUFS); return; }
        ssize_t n = read(p->fds[i], p->reverse + i * p->reverse_cap + offset, p->reverse_cap - offset);
        if (n > 0) atomic_store(&p->received[i], offset + (size_t)n);
        else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) atomic_store(&p->error, errno);
    }
}
static void *run_producer(void *context) {
    struct producer *p = context;
    pthread_setname_np(pthread_self(), "actor-producer");
    atomic_store(&p->tid, (int)syscall(SYS_gettid));
    for (unsigned tick = 0; tick < p->records && !atomic_load(&p->stop); tick++) {
        for (unsigned lane = 0; lane < p->lanes && !atomic_load(&p->stop); lane++) {
            uint64_t due = p->start + (uint64_t)tick * 50000000 + (p->stagger ? (uint64_t)lane * 50000000 / p->lanes : 0);
            struct timespec deadline = {.tv_sec = due / 1000000000, .tv_nsec = due % 1000000000};
            if (p->stagger || lane == 0) {
                int status;
                while ((status = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, NULL)) == EINTR) {}
                if (status) { atomic_store(&p->error, status); goto done; }
            }
            size_t timing = ((size_t)lane * p->records + tick) * 2;
            p->write_times[timing] = actor_now_ns();
            size_t end = (size_t)(tick + 1) * p->size;
            while (atomic_load(&p->written[lane]) < end && !atomic_load(&p->stop)) {
                size_t offset = atomic_load(&p->written[lane]), amount = end - offset;
                if (p->fragment && amount > p->fragment) amount = p->fragment;
                ssize_t n = write(p->fds[lane], p->bytes + (size_t)lane * p->records * p->size + offset, amount);
                if (n > 0) atomic_store(&p->written[lane], offset + (size_t)n);
                else if (n < 0 && errno == EINTR) continue;
                else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    struct pollfd fd = {.fd = p->fds[lane], .events = POLLOUT};
                    poll(&fd, 1, 1);
                    receive_input(p);
                } else { atomic_store(&p->error, n < 0 ? errno : EIO); goto done; }
            }
            p->write_times[timing + 1] = actor_now_ns();
        }
        receive_input(p);
    }
done:
    atomic_store(&p->done, 1);
    while (!atomic_load(&p->stop)) {
        receive_input(p);
        struct timespec nap = {.tv_nsec = 1000000};
        nanosleep(&nap, NULL);
    }
    receive_input(p);
    atomic_store(&p->completed_cpu, clock_ns(CLOCK_THREAD_CPUTIME_ID));
    return NULL;
}
void *actor_producer(const int *fds, unsigned lanes, const void *bytes, unsigned records, unsigned size,
                     int stagger, unsigned fragment, unsigned reverse_cap) {
    if (!lanes || lanes > MAX_LANES || !records || !size || !reverse_cap) return NULL;
    struct producer *p = calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->reverse = calloc(lanes, reverse_cap);
    if (!p->reverse) { free(p); return NULL; }
    p->write_times = calloc((size_t)lanes * records * 2, sizeof(*p->write_times));
    if (!p->write_times) { free(p->reverse); free(p); return NULL; }
    memcpy(p->fds, fds, lanes * sizeof(*fds));
    p->lanes = lanes; p->bytes = bytes; p->records = records; p->size = size;
    p->stagger = stagger; p->fragment = fragment; p->reverse_cap = reverse_cap;
    atomic_store(&p->receive, 1);
    p->start = actor_now_ns() + 100000000;
    if (pthread_create(&p->thread, NULL, run_producer, p)) { free(p->write_times); free(p->reverse); free(p); return NULL; }
    return p;
}
uint64_t actor_producer_start(void *context) { return ((struct producer *)context)->start; }
void actor_producer_receive(void *context, int enabled) { atomic_store(&((struct producer *)context)->receive, enabled != 0); }
void actor_producer_stats(void *context, uint64_t *out) {
    struct producer *p = context;
    out[0] = atomic_load(&p->done); out[1] = atomic_load(&p->error);
    out[2] = atomic_load(&p->completed_cpu);
    if (!out[2]) out[2] = thread_cpu(p->thread);
    out[3] = atomic_load(&p->tid);
    for (unsigned i = 0; i < p->lanes; i++) { out[4 + i] = atomic_load(&p->written[i]); out[4 + p->lanes + i] = atomic_load(&p->received[i]); }
}
void actor_producer_join(void *context) {
    struct producer *p = context;
    if (atomic_exchange(&p->stop, 1)) return;
    pthread_join(p->thread, NULL);
}
/* Call after join; bytes never escape into a borrowed Bun view. */
size_t actor_producer_reverse(void *context, unsigned lane, void *out, size_t cap) {
    struct producer *p = context;
    if (lane >= p->lanes || !atomic_load(&p->stop)) return SIZE_MAX;
    size_t size = atomic_load(&p->received[lane]);
    if (size > cap) return SIZE_MAX;
    memcpy(out, p->reverse + lane * p->reverse_cap, size);
    return size;
}
/* Read only after join. Each lane has records pairs of absolute start/end ns. */
size_t actor_producer_schedule(void *context, uint64_t *out, size_t cap) {
    struct producer *p = context;
    size_t count = (size_t)p->lanes * p->records * 2;
    if (!atomic_load(&p->stop) || cap < count) return SIZE_MAX;
    memcpy(out, p->write_times, count * sizeof(*out));
    return count;
}
void actor_producer_free(void *context) {
    struct producer *p = context;
    if (!p) return;
    actor_producer_join(p);
    free(p->write_times); free(p->reverse); free(p);
}
