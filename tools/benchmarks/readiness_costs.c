/* Benchmark-only wrapper: compile the exact READINESS_SOURCE unchanged. */
#define _GNU_SOURCE
#include <sys/epoll.h>
#include <sys/socket.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>

typedef void (*ready_callback)(uint32_t, uint32_t);
static ready_callback callback;
void bench_set_callback(ready_callback value) { callback = value; }
#ifdef READINESS_COUNTS
static _Atomic uint64_t counters[75];
static uint32_t notification_words[32768];
static _Atomic uint32_t notification_length;
#endif
#if defined(READINESS_COUNTS) || defined(READINESS_CALLBACK)
static ssize_t notification_send(int fd, const void *data, size_t size, int flags) {
#ifdef READINESS_CALLBACK
    (void)fd; (void)flags;
    if (!callback || size % 8) { errno = EINVAL; return -1; }
    for (size_t offset = 0; offset < size; offset += 8) {
        uint32_t record[2];
        memcpy(record, (const char *)data + offset, sizeof(record));
#ifdef READINESS_COUNTS
        atomic_fetch_add_explicit(&counters[74], 1, memory_order_relaxed);
#endif
        callback(record[0], record[1]);
    }
    return (ssize_t)size;
#else
    return send(fd, data, size, flags);
#endif
}
#endif
#ifdef READINESS_COUNTS
static _Thread_local uint32_t expected_words[128];
static _Thread_local size_t expected_length, expected_offset;
static int counted_wait(int fd, struct epoll_event *events, int maximum, int timeout) {
    if (expected_offset != expected_length)
        atomic_fetch_add_explicit(&counters[73], 1, memory_order_relaxed);
    int count = epoll_wait(fd, events, maximum, timeout);
    atomic_fetch_add_explicit(&counters[0], 1, memory_order_relaxed);
    if (count >= 0 && count <= 64) {
        expected_length = (size_t)count * 8;
        expected_offset = 0;
        for (int i = 0; i < count; i++) {
            expected_words[i * 2] = events[i].data.u32;
            expected_words[i * 2 + 1] = events[i].events;
            uint32_t offset = atomic_load_explicit(&notification_length, memory_order_relaxed);
            if (offset + 2 <= sizeof(notification_words) / sizeof(notification_words[0])) {
                notification_words[offset] = events[i].data.u32;
                notification_words[offset + 1] = events[i].events;
                atomic_store_explicit(&notification_length, offset + 2, memory_order_release);
            } else atomic_fetch_add_explicit(&counters[73], 1, memory_order_relaxed);
        }
        atomic_fetch_add_explicit(&counters[1], count, memory_order_relaxed);
        atomic_fetch_add_explicit(&counters[8 + count], 1, memory_order_relaxed);
    } else if (count < 0 && errno == EINTR) {
        atomic_fetch_add_explicit(&counters[6], 1, memory_order_relaxed);
    }
    return count;
}
static ssize_t counted_send(int fd, const void *data, size_t size, int flags) {
    if (expected_offset > expected_length || size > expected_length - expected_offset ||
        memcmp(data, (const char *)expected_words + expected_offset, size))
        atomic_fetch_add_explicit(&counters[73], 1, memory_order_relaxed);
    ssize_t count = notification_send(fd, data, size, flags);
    atomic_fetch_add_explicit(&counters[2], 1, memory_order_relaxed);
    if (count > 0) {
        expected_offset += (size_t)count;
        atomic_fetch_add_explicit(&counters[3], count, memory_order_relaxed);
        if ((size_t)count < size) atomic_fetch_add_explicit(&counters[4], 1, memory_order_relaxed);
    } else if (count < 0 && errno == EINTR) {
        atomic_fetch_add_explicit(&counters[5], 1, memory_order_relaxed);
    }
    return count;
}
static int counted_ctl(int fd, int operation, int target, struct epoll_event *event) {
    atomic_fetch_add_explicit(&counters[7], 1, memory_order_relaxed);
    return epoll_ctl(fd, operation, target, event);
}
#define epoll_wait counted_wait
#define epoll_ctl counted_ctl
#define send counted_send
#elif defined(READINESS_CALLBACK)
#define send notification_send
#endif

#include READINESS_SOURCE

#ifdef READINESS_COUNTS
#undef epoll_wait
#undef epoll_ctl
#endif
#if defined(READINESS_COUNTS) || defined(READINESS_CALLBACK)
#undef send
#endif

void bench_counts(uint64_t *out) {
    for (int i = 0; i < 75; i++) {
#ifdef READINESS_COUNTS
        out[i] = atomic_load_explicit(&counters[i], memory_order_relaxed);
#else
        out[i] = 0;
#endif
    }
}
uint32_t bench_notifications(uint32_t *out, uint32_t capacity) {
#ifdef READINESS_COUNTS
    uint32_t count = atomic_load_explicit(&notification_length, memory_order_acquire);
    if (count > capacity) return UINT32_MAX;
    memcpy(out, notification_words, count * sizeof(*out));
    return count;
#else
    (void)out; (void)capacity;
    return 0;
#endif
}
struct queued_callbacks { const uint32_t *tokens; uint32_t count, events; };
static void *enqueue_callbacks(void *context) {
    struct queued_callbacks *q = context;
    for (uint32_t i = 0; i < q->count; i++) callback(q->tokens[i], q->events);
    return NULL;
}
int bench_enqueue(const uint32_t *tokens, uint32_t count, uint32_t events) {
    if (!callback) return EINVAL;
    struct queued_callbacks q = {.tokens = tokens, .count = count, .events = events};
    pthread_t thread;
    int error = pthread_create(&thread, NULL, enqueue_callbacks, &q);
    if (error) return error;
    return pthread_join(thread, NULL);
}
struct delayed_callback { pthread_t thread; uint32_t token, events; };
static void *deliver_later(void *context) {
    struct delayed_callback *d = context;
    struct timespec delay = {.tv_nsec = 100000000};
    while (nanosleep(&delay, &delay) && errno == EINTR) {}
    callback(d->token, d->events);
    return NULL;
}
void *bench_defer(uint32_t token, uint32_t events) {
    if (!callback) return NULL;
    struct delayed_callback *d = calloc(1, sizeof(*d));
    if (!d) return NULL;
    d->token = token; d->events = events;
    if (pthread_create(&d->thread, NULL, deliver_later, d)) { free(d); return NULL; }
    return d;
}
void bench_defer_join(void *context) {
    struct delayed_callback *d = context;
    pthread_join(d->thread, NULL);
    free(d);
}
uint64_t bench_now_ns(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return 0;
    return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}
static uint64_t thread_cpu(pthread_t thread) {
    clockid_t id;
    struct timespec value;
    if (pthread_getcpuclockid(thread, &id) || clock_gettime(id, &value)) return 0;
    return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}
uint64_t bench_ready_cpu(void *context) {
    return thread_cpu(((struct fd_loop *)context)->thread);
}

enum { lanes = 16, record_size = 128 };
struct producer {
    pthread_t thread;
    int fds[lanes];
    uint32_t ticks, staggered, timestamps;
    uint64_t start;
    unsigned char *expected;
    atomic_int stop, done, error;
    _Atomic uint64_t completed_cpu;
};
static void *produce(void *context) {
    struct producer *p = context;
    pthread_setname_np(pthread_self(), "ready-producer");
    const uint64_t period = 50000000;
    for (uint32_t tick = 0; tick < p->ticks; tick++) {
        for (uint32_t lane = 0; lane < lanes; lane++) {
            if (atomic_load_explicit(&p->stop, memory_order_relaxed)) goto done;
            uint64_t deadline = p->start + tick * period + (p->staggered ? lane * period / lanes : 0);
            struct timespec until = {.tv_sec = deadline / 1000000000, .tv_nsec = deadline % 1000000000};
            if (p->staggered || !lane)
                while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &until, NULL) == EINTR) {}
            unsigned char *bytes = p->expected + ((size_t)lane * p->ticks + tick) * record_size;
            if (p->timestamps) {
                uint64_t at = bench_now_ns();
                memcpy(bytes + 8, &at, sizeof(at));
            }
            size_t offset = 0;
            while (offset < record_size) {
                ssize_t written = send(p->fds[lane], bytes + offset, record_size - offset, MSG_NOSIGNAL);
                if (written < 0 && errno == EINTR) continue;
                if (written <= 0) {
                    atomic_store(&p->error, written < 0 ? errno : EIO);
                    goto done;
                }
                offset += written;
            }
        }
    }
done:
    atomic_store(&p->completed_cpu, thread_cpu(pthread_self()));
    atomic_store_explicit(&p->done, 1, memory_order_release);
    return NULL;
}
void *bench_producer(int *fds, uint32_t ticks, int staggered, int timestamps, unsigned char *expected) {
    struct producer *p = calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->ticks = ticks;
    p->staggered = staggered;
    p->timestamps = timestamps;
    p->expected = expected;
    p->start = bench_now_ns() + 20000000;
    for (uint32_t lane = 0; lane < lanes; lane++) {
        p->fds[lane] = fds[lane];
        int flags = fcntl(fds[lane], F_GETFL);
        if (flags < 0 || fcntl(fds[lane], F_SETFL, flags & ~O_NONBLOCK) < 0) { free(p); return NULL; }
        for (uint32_t tick = 0; tick < ticks; tick++) {
            unsigned char *bytes = expected + ((size_t)lane * ticks + tick) * record_size;
            memcpy(bytes, &lane, sizeof(lane));
            memcpy(bytes + 4, &tick, sizeof(tick));
            memset(bytes + 8, 0, 8);
            for (size_t i = 16; i < record_size; i++) bytes[i] = (unsigned char)(lane * 31 + tick * 7 + i);
        }
    }
    if (pthread_create(&p->thread, NULL, produce, p)) { free(p); return NULL; }
    return p;
}
uint64_t bench_producer_start(void *context) { return ((struct producer *)context)->start; }
uint64_t bench_producer_cpu(void *context) {
    struct producer *p = context;
    return atomic_load_explicit(&p->done, memory_order_acquire) ? atomic_load(&p->completed_cpu) : thread_cpu(p->thread);
}
int bench_producer_error(void *context) { return atomic_load(&((struct producer *)context)->error); }
void bench_producer_free(void *context) {
    struct producer *p = context;
    atomic_store(&p->stop, 1);
    for (int lane = 0; lane < lanes; lane++) shutdown(p->fds[lane], SHUT_WR);
    pthread_join(p->thread, NULL);
    free(p);
}
