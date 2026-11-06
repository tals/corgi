/** Per connection, including decoded requests waiting for their effects. */
export const request_bytes = 4 * 1024 * 1024;
export const requests = 64;
export const output_bytes = 4 * 1024 * 1024;
export const output_high = 1024 * 1024;
/** JSON escaping can expand each UTF-16 code unit to six bytes. */
export const surface_chunk_chars = 32 * 1024;
export const surface_bytes = 16 * 1024 * 1024;
