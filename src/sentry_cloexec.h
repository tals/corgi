// Included ahead of every sentry-native source. Sentry keeps a lock file
// open for the life of the process; without O_CLOEXEC it would stay open in
// every shell and agent corgi spawns.
#include <fcntl.h>
#define open(path, flags, ...) open(path, (flags) | O_CLOEXEC, ##__VA_ARGS__)
