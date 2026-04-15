#!/bin/sh

# stop_claude_adapter.sh
# 停止由 start_claude_adapter.sh 启动的后台进程

# 匹配模式：node 进程且包含 dist/cli.js 和 -l DEBUG
PATTERN="node.*dist/cli.js.*"

# 查找匹配的 PID（不包含 grep 自身）
PIDS=$(ps aux | grep -E "$PATTERN" | grep -v grep | awk '{print $2}')

if [ -z "$PIDS" ]; then
    echo "未找到运行中的 claude_adapter 进程"
    exit 0
fi

echo "找到以下进程:"
ps aux | grep -E "$PATTERN" | grep -v grep

# 逐个终止
for pid in $PIDS; do
    echo "正在终止 PID: $pid"
    kill "$pid"
    # 可选：等待进程结束，若未结束则强制终止
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
        echo "进程 $pid 未响应，尝试强制终止"
        kill -9 "$pid"
    fi
done

echo "已停止所有匹配的进程"
