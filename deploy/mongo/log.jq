# MongoDB's json log lines in the columns of the server's own log (backend/src/core/logger.ts):
#   2026-10-06 10:44:50.251 | INFO  | storage  | createCollection                         | namespace=kibbl.devices
# A line that is not a MongoDB log entry is passed on as it is. jq 1.6, the version of the mongo image.

# the handshake of every new connection of the app (driver metadata, no authentication on
# the private network, its first command): nothing to act on, dropped
def noise: .id == 51800 or .id == 10483900 or .id == 6788700;

def pad($n): tostring | if length >= $n then . else . + ([range($n - length)] | map(" ") | add) end;

def short: if length > 80 then .[0:77] + "..." else . end;

def level:
    if . == "F" then "FATAL"
    elif . == "E" then "ERROR"
    elif . == "W" then "WARN"
    elif . == "I" then "INFO"
    else "DEBUG" end;

# as the server writes a value: quoted when it has spaces, quotes, = or |
def value:
    if type == "string" then (short | if test("[\\s=\"|]") or . == "" then tojson else . end)
    elif type == "object" or type == "array" then (tojson | short)
    else tostring end;

# MongoDB's internal names of files and builds, and empty values: nothing a reader can use
def internal: . as $key | ["ident", "collectionIdent", "buildUUID", "collectionUUID", "uuid", "uuidDisposition"] | index([$key]) != null;

# an error object of MongoDB ({code, codeName, errmsg}) as its message
def detail($key):
    if $key == "error" and type == "object" then (.errmsg // .codeName // tojson)
    else . end;

# plain values only on an info line; a warning or error keeps its nested details, shortened
def fields($all):
    [(.attr // {}) | to_entries[]
        | select((.key | internal | not) and .value != null)
        | .key as $key
        | .value |= detail($key)
        | select($all or ((.value | type) != "object" and (.value | type) != "array"))
        | "\(.key)=\(.value | value)"]
    | join(" ");

def format:
    (.t["$date"] | tostring | sub("T"; " ") | .[0:23]) as $time
    | (.s | tostring | level) as $level
    | fields($level != "INFO" and $level != "DEBUG") as $details
    | [$time, ($level | pad(5)), (.c | tostring | ascii_downcase | pad(8))]
      + (if $details == "" then [.msg] else [(.msg | pad(40)), $details] end)
    | join(" | ");

# a line this filter cannot format is written as it came: never lost
. as $line
| (try fromjson catch null) as $j
| if ($j | type) == "object" and ($j.t | type) == "object" and ($j.msg | type) == "string" then
      if ($j | noise) then empty else (try ($j | format) catch $line) end
  else $line end
