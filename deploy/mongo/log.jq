# MongoDB's json log lines in the columns of the server's own log (backend/src/core/logger.ts):
#   2026-10-06 10:44:50.251 | INFO  | access   | Connection not authenticating            | client=172.21.0.3:58428
# A line that is not a MongoDB log entry is passed on as it is. jq 1.6, the version of the mongo image.

def pad($n): tostring | if length >= $n then . else . + ([range($n - length)] | map(" ") | add) end;

def level:
    if . == "F" then "FATAL"
    elif . == "E" then "ERROR"
    elif . == "W" then "WARN"
    elif . == "I" then "INFO"
    else "DEBUG" end;

# as the server writes a value: quoted when it has spaces, quotes, = or |, objects as short json
def value:
    if type == "string" then (if test("[\\s=\"|]") or . == "" then tojson else . end)
    elif type == "object" or type == "array" then (tojson | if length > 120 then .[0:117] + "..." else . end)
    else tostring end;

def fields: [(.attr // {}) | to_entries[] | "\(.key)=\(.value | value)"] | join(" ");

. as $line
| (try fromjson catch null) as $j
| if ($j | type) == "object" and ($j.t | type) == "object" and ($j.msg | type) == "string" then
      ($j.t["$date"] | tostring | sub("T"; " ") | .[0:23]) as $time
      | ($j | fields) as $details
      | [$time, ($j.s | tostring | level | pad(5)), ($j.c | tostring | ascii_downcase | pad(8))]
        + (if $details == "" then [$j.msg] else [($j.msg | pad(40)), $details] end)
      | join(" | ")
  else $line end
