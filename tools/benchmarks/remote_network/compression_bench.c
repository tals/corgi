// Codec-only benchmark. Inputs and compression boundaries are identical for
// every codec.
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zdict.h>
#include <zlib.h>
#include <zstd.h>

typedef struct {
  unsigned char *p;
  size_t n, cap;
} Buffer;
typedef struct {
  Buffer *messages;
  size_t count, bytes, largest;
} Corpus;
typedef struct {
  size_t live, peak;
} Allocation;
typedef struct {
  int zstd, stream, level, legacy;
  ZSTD_CCtx *enc;
  ZSTD_DCtx *dec;
  ZSTD_CDict *cdict;
  ZSTD_DDict *ddict;
  z_stream ze, zd;
  Allocation ea, da;
} Codec;

static double clock_ns(clockid_t kind) {
  struct timespec t;
  if (clock_gettime(kind, &t))
    abort();
  return (double)t.tv_sec * 1e9 + t.tv_nsec;
}
static void fail(const char *s) {
  fprintf(stderr, "%s\n", s);
  exit(1);
}
static void check(size_t result) {
  if (ZSTD_isError(result))
    fail(ZSTD_getErrorName(result));
}
static void *allocate(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p)
    fail("OutOfMemory");
  return p;
}
static uint32_t read32(FILE *f) {
  unsigned char b[4];
  if (fread(b, 1, 4, f) != 4)
    fail("ShortCorpus");
  return b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 |
         (uint32_t)b[3] << 24;
}
static Corpus corpus(const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f)
    fail("MissingCorpus");
  Corpus c = {0};
  c.count = read32(f);
  if (!c.count || c.count > 100000)
    fail("InvalidCount");
  c.messages = calloc(c.count, sizeof(Buffer));
  if (!c.messages)
    abort();
  for (size_t i = 0; i < c.count; i++) {
    Buffer *b = &c.messages[i];
    b->n = read32(f);
    if (b->n > 32 * 1024 * 1024)
      fail("InvalidLength");
    b->p = allocate(b->n);
    if (fread(b->p, 1, b->n, f) != b->n)
      fail("ShortCorpus");
    c.bytes += b->n;
    if (b->n > c.largest)
      c.largest = b->n;
  }
  if (fgetc(f) != EOF)
    fail("TrailingCorpus");
  fclose(f);
  return c;
}
static Buffer file_bytes(const char *path) {
  Buffer b = {0};
  if (!strcmp(path, "-"))
    return b;
  FILE *f = fopen(path, "rb");
  if (!f)
    fail("MissingDictionary");
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  if (n < 0)
    abort();
  rewind(f);
  b.n = (size_t)n;
  b.p = allocate(b.n);
  if (fread(b.p, 1, b.n, f) != b.n)
    abort();
  fclose(f);
  return b;
}
static voidpf zalloc_track(voidpf opaque, uInt count, uInt size) {
  Allocation *a = opaque;
  size_t n = (size_t)count * size;
  size_t *p = allocate(n + sizeof(size_t));
  *p = n;
  a->live += n;
  if (a->live > a->peak)
    a->peak = a->live;
  return p + 1;
}
static void zfree_track(voidpf opaque, voidpf address) {
  Allocation *a = opaque;
  size_t *p = (size_t *)address - 1;
  a->live -= *p;
  free(p);
}
static void reset_encode(Codec *c) {
  if (c->zstd)
    check(ZSTD_CCtx_reset(c->enc, ZSTD_reset_session_only));
  else if (deflateReset(&c->ze) != Z_OK)
    abort();
}
static void reset_decode(Codec *c) {
  if (c->zstd)
    check(ZSTD_DCtx_reset(c->dec, ZSTD_reset_session_only));
  else if (inflateReset(&c->zd) != Z_OK)
    abort();
}
static void encode(Codec *c, const Buffer *src, Buffer *dst) {
  if (c->zstd && !c->stream) {
    dst->n = ZSTD_compress2(c->enc, dst->p, dst->cap, src->p, src->n);
    check(dst->n);
  } else if (c->zstd) {
    ZSTD_inBuffer in = {src->p, src->n, 0};
    ZSTD_outBuffer out = {dst->p, dst->cap, 0};
    size_t left;
    do {
      left = ZSTD_compressStream2(c->enc, &out, &in, ZSTD_e_flush);
      check(left);
      if (out.pos == out.size && left)
        fail("OutputFull");
    } while (left || in.pos < in.size);
    dst->n = out.pos;
  } else {
    c->ze.next_in = src->p;
    c->ze.avail_in = (uInt)src->n;
    c->ze.next_out = dst->p;
    c->ze.avail_out = (uInt)dst->cap;
    int code = deflate(&c->ze, Z_PARTIAL_FLUSH);
    if (code != Z_OK || c->ze.avail_in || !c->ze.avail_out)
      fail("DeflateFailed");
    dst->n = dst->cap - c->ze.avail_out;
  }
}
static size_t decode(Codec *c, const Buffer *src, Buffer *dst) {
  if (c->zstd) {
    ZSTD_inBuffer in = {src->p, src->n, 0};
    ZSTD_outBuffer out = {dst->p, dst->cap, 0};
    while (in.pos < in.size) {
      size_t before = in.pos;
      size_t code = ZSTD_decompressStream(c->dec, &out, &in);
      check(code);
      if (in.pos == before || out.pos == out.size)
        fail("DecodeStalled");
    }
    return out.pos;
  }
  c->zd.next_in = src->p;
  c->zd.avail_in = (uInt)src->n;
  c->zd.next_out = dst->p;
  c->zd.avail_out = (uInt)dst->cap;
  int code = inflate(&c->zd, Z_SYNC_FLUSH);
  if ((code != Z_OK && code != Z_STREAM_END) || c->zd.avail_in)
    fail("InflateFailed");
  return dst->cap - c->zd.avail_out;
}
static void initialize(Codec *c, Buffer dict) {
  if (c->zstd) {
    c->enc = ZSTD_createCCtx();
    c->dec = ZSTD_createDCtx();
    if (!c->enc || !c->dec)
      abort();
    check(ZSTD_CCtx_setParameter(c->enc, ZSTD_c_compressionLevel, c->level));
    if (dict.n) {
      c->cdict = ZSTD_createCDict(dict.p, dict.n, c->level);
      c->ddict = ZSTD_createDDict(dict.p, dict.n);
      if (!c->cdict || !c->ddict)
        fail("DictionaryInit");
      check(ZSTD_CCtx_refCDict(c->enc, c->cdict));
      check(ZSTD_DCtx_refDDict(c->dec, c->ddict));
    }
  } else {
    c->ze.zalloc = zalloc_track;
    c->ze.zfree = zfree_track;
    c->ze.opaque = &c->ea;
    c->zd.zalloc = zalloc_track;
    c->zd.zfree = zfree_track;
    c->zd.opaque = &c->da;
    if (deflateInit2(&c->ze, c->legacy ? 6 : 1, Z_DEFLATED, 15, 8,
                     c->legacy ? Z_DEFAULT_STRATEGY : Z_HUFFMAN_ONLY) != Z_OK)
      abort();
    if (inflateInit(&c->zd) != Z_OK)
      abort();
  }
}
static void train(Corpus c, const char *path, size_t capacity) {
  unsigned char *all = allocate(c.bytes), *dict = allocate(capacity);
  size_t *sizes = allocate(c.count * sizeof(size_t)), at = 0;
  for (size_t i = 0; i < c.count; i++) {
    memcpy(all + at, c.messages[i].p, c.messages[i].n);
    sizes[i] = c.messages[i].n;
    at += sizes[i];
  }
  double begin = clock_ns(CLOCK_THREAD_CPUTIME_ID);
  size_t n =
      ZDICT_trainFromBuffer(dict, capacity, all, sizes, (unsigned)c.count);
  double elapsed = clock_ns(CLOCK_THREAD_CPUTIME_ID) - begin;
  if (ZDICT_isError(n))
    fail(ZDICT_getErrorName(n));
  FILE *f = fopen(path, "wb");
  if (!f || fwrite(dict, 1, n, f) != n)
    abort();
  fclose(f);
  printf("{\"dictionary_bytes\":%zu,\"samples\":%zu,\"training_bytes\":%zu,"
         "\"training_cpu_ms\":%.3f}\n",
         n, c.count, c.bytes, elapsed / 1e6);
}
int main(int argc, char **argv) {
  if (argc == 5 && !strcmp(argv[1], "train")) {
    train(corpus(argv[2]), argv[3], (size_t)atoi(argv[4]));
    return 0;
  }
  if (argc != 6)
    fail("Usage: compression_bench CORPUS ssh|legacy|zstd-frame|zstd-stream "
         "LEVEL DICTIONARY|- TARGET_MS");
  Corpus input = corpus(argv[1]);
  Codec codec = {0};
  codec.zstd = !strncmp(argv[2], "zstd", 4);
  codec.stream = !strcmp(argv[2], "zstd-stream");
  codec.level = atoi(argv[3]);
  codec.legacy = !strcmp(argv[2], "legacy");
  Buffer dict = file_bytes(argv[4]);
  double init = clock_ns(CLOCK_THREAD_CPUTIME_ID);
  initialize(&codec, dict);
  init = clock_ns(CLOCK_THREAD_CPUTIME_ID) - init;
  Buffer *encoded = calloc(input.count, sizeof(Buffer));
  size_t total = 0;
  Buffer decoded = {.cap = input.largest + 1};
  decoded.p = allocate(decoded.cap);
  for (size_t i = 0; i < input.count; i++) {
    encoded[i].cap = ZSTD_compressBound(input.messages[i].n) + 65536;
    encoded[i].p = allocate(encoded[i].cap);
  }
  reset_encode(&codec);
  reset_decode(&codec);
  double cold = clock_ns(CLOCK_THREAD_CPUTIME_ID);
  encode(&codec, &input.messages[0], &encoded[0]);
  double first_encode = clock_ns(CLOCK_THREAD_CPUTIME_ID) - cold;
  for (size_t i = 1; i < input.count; i++)
    encode(&codec, &input.messages[i], &encoded[i]);
  cold = clock_ns(CLOCK_THREAD_CPUTIME_ID) - cold;
  for (size_t i = 0; i < input.count; i++) {
    size_t n = decode(&codec, &encoded[i], &decoded);
    if (n != input.messages[i].n || memcmp(decoded.p, input.messages[i].p, n))
      fail("RoundtripMismatch");
    total += encoded[i].n;
  }
  const double target = atof(argv[5]) * 1e6;
  size_t eruns = 0, druns = 0;
  double start = clock_ns(CLOCK_THREAD_CPUTIME_ID), elapsed;
  do {
    reset_encode(&codec);
    for (size_t i = 0; i < input.count; i++)
      encode(&codec, &input.messages[i], &encoded[i]);
    eruns++;
    elapsed = clock_ns(CLOCK_THREAD_CPUTIME_ID) - start;
  } while (elapsed < target);
  double enc_us = elapsed / (double)(eruns * input.count) / 1000;
  start = clock_ns(CLOCK_THREAD_CPUTIME_ID);
  do {
    reset_decode(&codec);
    for (size_t i = 0; i < input.count; i++)
      decode(&codec, &encoded[i], &decoded);
    druns++;
    elapsed = clock_ns(CLOCK_THREAD_CPUTIME_ID) - start;
  } while (elapsed < target);
  double dec_us = elapsed / (double)(druns * input.count) / 1000;
  // Verify again after timed context reuse, outside the timing interval.
  reset_decode(&codec);
  for (size_t i = 0; i < input.count; i++) {
    size_t n = decode(&codec, &encoded[i], &decoded);
    if (n != input.messages[i].n || memcmp(decoded.p, input.messages[i].p, n))
      fail("WarmRoundtripMismatch");
  }
  size_t enc_mem = codec.zstd ? ZSTD_sizeof_CCtx(codec.enc)
                              : codec.ea.peak + sizeof(z_stream);
  size_t dec_mem = codec.zstd ? ZSTD_sizeof_DCtx(codec.dec)
                              : codec.da.peak + sizeof(z_stream);
  size_t cdict_mem = codec.cdict ? ZSTD_sizeof_CDict(codec.cdict) : 0,
         ddict_mem = codec.ddict ? ZSTD_sizeof_DDict(codec.ddict) : 0;
  size_t stacked_bytes = 0;
  if (codec.zstd) {
    Codec ssh = {0};
    initialize(&ssh, (Buffer){0});
    Buffer stacked = {.cap = ZSTD_compressBound(input.largest) + 131072};
    stacked.p = allocate(stacked.cap);
    for (size_t i = 0; i < input.count; i++) {
      encode(&ssh, &encoded[i], &stacked);
      stacked_bytes += stacked.n;
    }
    deflateEnd(&ssh.ze);
    inflateEnd(&ssh.zd);
    free(stacked.p);
  }
  printf("{\"codec\":\"%s\",\"level\":%d,\"zstd_version\":\"%s\",\"zlib_"
         "version\":\"%s\",\"messages\":%zu,\"raw_bytes\":%zu,\"compressed_"
         "bytes\":%zu,\"first_message_bytes\":%zu,\"encode_us_per_message\":%."
         "6f,\"decode_us_per_message\":%.6f,\"encoder_bytes\":%zu,\"decoder_"
         "bytes\":%zu,\"cdict_bytes\":%zu,\"ddict_bytes\":%zu,\"setup_cpu_us\":"
         "%.3f,\"cold_encode_us_per_message\":%.6f,\"encode_iterations\":%zu,"
         "\"decode_iterations\":%zu,\"first_encode_us\":%.3f,"
         "\"stacked_ssh_bytes\":%zu,\"roundtrip\":true}\n",
         argv[2], codec.level, ZSTD_versionString(), zlibVersion(), input.count,
         input.bytes, total, encoded[0].n, enc_us, dec_us, enc_mem, dec_mem,
         cdict_mem, ddict_mem, init / 1000, cold / input.count / 1000, eruns,
         druns, first_encode / 1000, stacked_bytes);
  if (codec.zstd) {
    ZSTD_freeCCtx(codec.enc);
    ZSTD_freeDCtx(codec.dec);
    ZSTD_freeCDict(codec.cdict);
    ZSTD_freeDDict(codec.ddict);
  } else {
    deflateEnd(&codec.ze);
    inflateEnd(&codec.zd);
  }
  for (size_t i = 0; i < input.count; i++) {
    free(input.messages[i].p);
    free(encoded[i].p);
  }
  free(input.messages);
  free(encoded);
  free(decoded.p);
  free(dict.p);
  return 0;
}
