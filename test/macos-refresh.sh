#!/bin/bash
# Exercise the published GUI outside a checkout, where it must use the installed CLI.
set -eu
sandbox=$(mktemp -d)
gui_pid=
cleanup() {
  if [ -n "$gui_pid" ]; then
    kill "$gui_pid" 2>/dev/null || true
    wait "$gui_pid" 2>/dev/null || true
  fi
  rm -rf "$sandbox"
}
trap cleanup EXIT
mkdir -p "$sandbox/app" "$sandbox/path" "$sandbox/home"
cp "$1" "$sandbox/app/RefreshProbe"

# Intercept the sibling that would have been the GUI itself in the shipped app.
cat > "$sandbox/app/MultiGrokState" <<'SH'
#!/bin/sh
echo "GUI received $*" >> "$REFRESH_LOG"
exit 1
SH
cat > "$sandbox/path/MultiGrokState" <<'SH'
#!/bin/sh
echo "$*" >> "$REFRESH_LOG"
case "$*" in
  'list --json') echo '[{"name":"test","status":"valid"}]' ;;
  'usage --json') echo '[{"name":"test","ok":true,"creditUsagePercent":10}]' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$sandbox/app/MultiGrokState" "$sandbox/path/MultiGrokState"
export PATH="$sandbox/path:$PATH" REFRESH_LOG="$sandbox/calls"
export GROK_HOME="$sandbox/home" GROK_STATE_HOME="$sandbox/home"
unset MULTIGROKSTATE_CLI
touch "$REFRESH_LOG"
cd "$sandbox"
"$sandbox/app/RefreshProbe" &
gui_pid=$!
for ((i=0; i<150; i++)); do
  if grep -q '^GUI received' "$REFRESH_LOG"; then cat "$REFRESH_LOG"; exit 1; fi
  if grep -qx 'usage --json' "$REFRESH_LOG"; then break; fi
  kill -0 "$gui_pid" || exit 1
  sleep 0.1
done
printf 'list --json\nusage --json\n' > "$sandbox/expected"
diff -u "$sandbox/expected" "$REFRESH_LOG"

# A wrong override or a PATH containing the bundle must still fail before opening a window.
kill "$gui_pid"
wait "$gui_pid" || true
gui_pid=
"$sandbox/app/RefreshProbe" list --json 2>"$sandbox/error" &
gui_pid=$!
for ((i=0; i<50; i++)); do
  if ! kill -0 "$gui_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if kill -0 "$gui_pid" 2>/dev/null; then echo "CLI arguments started the GUI"; exit 1; fi
status=0
wait "$gui_pid" || status=$?
gui_pid=
test "$status" -eq 2
grep -q MULTIGROKSTATE_CLI "$sandbox/error"
diff -u "$sandbox/expected" "$REFRESH_LOG"
