#include <unistd.h>
#include <sys/ioctl.h>
#include <stdio.h>
// Executed in a fresh single-threaded child, never fork Bun's JS runtime.
int main(int argc, char **argv) {
    if (argc < 2) return 127;
    if (setsid() < 0 || ioctl(0, TIOCSCTTY, 0) < 0) { perror("corgi: controlling terminal"); return 127; }
    execvp(argv[1], argv + 1);
    perror("corgi: exec");
    return 127;
}
