// The C headers Corgi's Zig code uses, translated once for every module.
// glibc's fortified variadic wrappers cannot be translated by Zig.
#undef _FORTIFY_SOURCE
#ifdef __APPLE__
// The macOS 26.5 and 27.0 SDKs assert Mach message struct sizes,
// but translate-c can't size their bitfields. Use the SDK's non-arm64 no-op.
#include <mach/port.h>
#undef xnu_static_assert_struct_size
#define xnu_static_assert_struct_size(name, size) _Static_assert(1, "")
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pwd.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <util.h>
#else
#include <pty.h>
#endif
