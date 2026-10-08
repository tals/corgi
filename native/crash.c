#define _GNU_SOURCE
#include <sentry.h>
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <limits.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <errno.h>
#include <string.h>

static char outbox[PATH_MAX];
static atomic_uint report_number;

// Called by sentry-native's transport thread, never into JavaScript. Fatal
// signals are saved by its existing in-process backend for the next startup.
static void save_envelope(sentry_envelope_t *envelope, void *unused) {
    (void)unused;
    size_t length=0;
    char *bytes=sentry_envelope_serialize(envelope,&length);
    if(bytes&&length<=16*1024*1024){
        char path[PATH_MAX];
        int size=snprintf(path,sizeof(path),"%s/%ld-%u.envelope",outbox,(long)getpid(),atomic_fetch_add(&report_number,1));
        if(size>0&&(size_t)size<sizeof(path)){
            int fd=open(path,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);
            if(fd>=0){
                size_t offset=0;
                while(offset<length){ssize_t n=write(fd,bytes+offset,length-offset);if(n<0&&errno==EINTR)continue;if(n<=0)break;offset+=(size_t)n;}
                fsync(fd);close(fd);if(offset!=length)unlink(path);
            }
        }
    }
    if(bytes)sentry_free(bytes);
    sentry_envelope_free(envelope);
}
int app_crash_init(const char *dsn,const char *database,const char *release,const char *role) {
    if(!*dsn)return 0;
    int size=snprintf(outbox,sizeof(outbox),"%s/outbox",database);
    if(size<=0||(size_t)size>=sizeof(outbox))return -1;
    if(mkdir(outbox,0700)&&errno!=EEXIST)return -1;
    sentry_options_t *options=sentry_options_new();if(!options)return -1;
    sentry_options_set_dsn(options,dsn);
    sentry_options_set_database_path(options,database);
    sentry_options_set_release(options,release);
    sentry_options_set_auto_session_tracking(options,0);
    sentry_options_set_transport(options,sentry_transport_new(save_envelope));
    if(sentry_init(options))return -1;
    sentry_set_tag("process",role);return 0;
}
void app_crash_close(void) { sentry_close(); }
