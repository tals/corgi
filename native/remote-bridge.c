#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

// Two bounded, independent directions. A slow reader must not stop the other direction.
struct lane {
    unsigned char bytes[65536];
    size_t start, end;
    int input, output, eof;
};

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static double now(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec + value.tv_nsec / 1e9;
}

static int transfer(struct lane *lane, short readable, short writable) {
    int progressed = 0;
    if (lane->start != lane->end && (writable & (POLLOUT | POLLERR | POLLHUP))) {
        ssize_t count = write(lane->output, lane->bytes + lane->start, lane->end - lane->start);
        if (count > 0) { lane->start += (size_t)count; progressed = 1; }
        else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return -1;
        if (lane->start == lane->end) lane->start = lane->end = 0;
    }
    if (!lane->eof && lane->end < sizeof(lane->bytes) && (readable & (POLLIN | POLLERR | POLLHUP))) {
        ssize_t count = read(lane->input, lane->bytes + lane->end, sizeof(lane->bytes) - lane->end);
        if (count > 0) { lane->end += (size_t)count; progressed = 1; }
        else if (count == 0) lane->eof = 1;
        else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return -1;
    }
    return progressed;
}

int main(int argc, char **argv) {
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (argc != 2 || argv[1][0] != '/' || strlen(argv[1]) >= sizeof(address.sun_path)) {
        fprintf(stderr, "usage: corgi-remote-bridge /absolute/daemon.sock\n");
        return 2;
    }
    signal(SIGPIPE, SIG_IGN);
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || nonblocking(fd) < 0) goto failure;
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        // Nothing listening: the caller starts the daemon and tries again.
        if (errno == ENOENT || errno == ECONNREFUSED) { close(fd); return 3; }
        if (errno != EINPROGRESS) goto failure;
        struct pollfd pending = { .fd = fd, .events = POLLOUT };
        if (poll(&pending, 1, 10000) <= 0) { errno = ETIMEDOUT; goto failure; }
        int error = 0;
        socklen_t length = sizeof(error);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0) goto failure;
        if (error) { errno = error; goto failure; }
    }
    if (nonblocking(STDIN_FILENO) < 0 || nonblocking(STDOUT_FILENO) < 0) goto failure;
    struct lane upload = { .input = STDIN_FILENO, .output = fd };
    struct lane download = { .input = fd, .output = STDOUT_FILENO };
    // The client discards SSH login banners up to this versioned boundary.
    const char marker[] = "\ncorgi-bridge-v1\n";
    memcpy(download.bytes, marker, sizeof(marker) - 1);
    download.end = sizeof(marker) - 1;
    int half_closed = 0;
    double activity = now();
    for (;;) {
        if (download.eof && download.start == download.end) { close(fd); return 0; }
        if (upload.eof && upload.start == upload.end && !half_closed) {
            if (shutdown(fd, SHUT_WR) < 0) goto failure;
            half_closed = 1;
        }
        struct pollfd fds[] = {
            { .fd = !upload.eof && upload.end < sizeof(upload.bytes) ? STDIN_FILENO : -1, .events = POLLIN },
            { .fd = fd, .events = (!download.eof && download.end < sizeof(download.bytes) ? POLLIN : 0) |
                (upload.start != upload.end ? POLLOUT : 0) },
            { .fd = download.start != download.end ? STDOUT_FILENO : -1, .events = POLLOUT },
        };
        if (!fds[1].events) fds[1].fd = -1;
        if (poll(fds, 3, 1000) < 0) { if (errno == EINTR) continue; goto failure; }
        int sent = transfer(&upload, fds[0].revents, fds[1].revents);
        int received = transfer(&download, fds[1].revents, fds[2].revents);
        if (sent < 0 || received < 0) goto failure;
        if (sent || received) activity = now();
        // Reap abandoned SSH channels, including a peer stuck on a full pipe;
        // a request may wait up to 120 s for its reply, as an agent's start does.
        if (now() - activity >= 180) { errno = ETIMEDOUT; goto failure; }
    }
failure:
    perror("corgi: remote bridge");
    if (fd >= 0) close(fd);
    return 1;
}
