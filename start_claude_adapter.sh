SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
nohup node "$SCRIPT_DIR"/dist/cli.js -l DEBUG > claude_adapter.log 2>&1 &
