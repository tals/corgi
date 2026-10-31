/* Linux-only lifecycle fixture. No application implementation is changed. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <pty.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <termios.h>
#include <unistd.h>

int pty_fixture_open(int *fds) {
    struct termios raw;
    if (openpty(&fds[0], &fds[1], NULL, NULL, NULL)) return -errno;
    if (tcgetattr(fds[1], &raw)) goto fail;
    cfmakeraw(&raw);
    if (tcsetattr(fds[1], TCSANOW, &raw)) goto fail;
    for (int i = 0; i < 2; i++) {
        int flags = fcntl(fds[i], F_GETFL);
        if (flags < 0 || fcntl(fds[i], F_SETFL, flags | O_NONBLOCK)) goto fail;
        if (fcntl(fds[i], F_SETFD, FD_CLOEXEC)) goto fail;
    }
    return 0;
fail:;
    int error = errno;
    close(fds[0]); close(fds[1]);
    return -error;
}

struct writer {
    pthread_t thread;
    int fd, repeat, signal_fd;
    const unsigned char *bytes;
    size_t length;
    _Atomic size_t written;
    atomic_int stop, error, done;
};
static void *write_fixture(void *context) {
    struct writer *w = context;
    pthread_setname_np(pthread_self(), "pty-fixture");
    size_t offset = 0;
    while ((w->repeat || offset < w->length) && !atomic_load(&w->stop)) {
        size_t position = offset % w->length;
        size_t length = w->length - position;
        if (length > 4096) length = 4096;
        ssize_t count = write(w->fd, w->bytes + position, length);
        if (count > 0) {
            offset += (size_t)count;
            atomic_store(&w->written, offset);
            if (w->signal_fd >= 0) {
                unsigned char ready = 1;
                if (write(w->signal_fd, &ready, 1) != 1) atomic_store(&w->error, errno);
                w->signal_fd = -1;
            }
        } else if (count < 0 && errno == EINTR) {
            continue;
        } else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            struct pollfd p = {.fd = w->fd, .events = POLLOUT};
            if (poll(&p, 1, 10) < 0 && errno != EINTR) {
                atomic_store(&w->error, errno);
                break;
            }
        } else {
            atomic_store(&w->error, count < 0 ? errno : EIO);
            break;
        }
    }
    atomic_store(&w->done, 1);
    return NULL;
}
void *pty_fixture_writer_ex(int fd, const unsigned char *bytes, size_t length, int repeat, int signal_fd) {
    if (!length) return NULL;
    struct writer *w = calloc(1, sizeof(*w));
    if (!w) return NULL;
    w->fd = fd; w->bytes = bytes; w->length = length;
    w->repeat = repeat; w->signal_fd = signal_fd;
    if (pthread_create(&w->thread, NULL, write_fixture, w)) { free(w); return NULL; }
    return w;
}
void *pty_fixture_writer(int fd, const unsigned char *bytes, size_t length) {
    return pty_fixture_writer_ex(fd, bytes, length, 0, -1);
}
void pty_fixture_status(void *context, uint64_t *out) {
    struct writer *w = context;
    out[0] = atomic_load(&w->written);
    out[1] = atomic_load(&w->done);
    out[2] = atomic_load(&w->error);
}
size_t pty_fixture_stop(void *context) {
    struct writer *w = context;
    atomic_store(&w->stop, 1);
    pthread_join(w->thread, NULL);
    size_t count = atomic_load(&w->written);
    free(w);
    return count;
}
