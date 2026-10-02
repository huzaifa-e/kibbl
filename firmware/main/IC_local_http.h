#ifndef IC_LOCAL_HTTP_H
#define IC_LOCAL_HTTP_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

/* The stream on the home network, without the server: a page on port 80
 * (/, /status, /capture) and the mjpeg stream on port 81 (/stream), since a stream
 * holds its server task as long as it is watched. One viewer at a time. Every
 * request needs ?key=<local key> ({"cmd":"info"} over serial prints the url). */
bool local_http_start(void);

#ifdef __cplusplus
}
#endif

#endif /* IC_LOCAL_HTTP_H */
