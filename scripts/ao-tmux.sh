#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="${AO_TMUX_SESSION:-agent-organizer}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE22_BIN="/home/mk/.nvm/versions/node/v22.22.0/bin"
SERVER_LOG="$REPO_DIR/data/logs/tmux-server.log"
CLIENT_LOG="$REPO_DIR/data/logs/tmux-client.log"
SERVER_PORT="${AO_SERVER_PORT:-8791}"
CLIENT_PORT="${AO_CLIENT_PORT:-5173}"

ensure_tmux() {
  command -v tmux >/dev/null 2>&1 || {
    echo "tmux is required." >&2
    exit 1
  }
}

ensure_node() {
  if [[ -d "$NODE22_BIN" ]]; then
    export PATH="$NODE22_BIN:$PATH"
  fi

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$node_major" -lt 22 ]]; then
    echo "Node.js >= 22 is required. Current: $(node -v 2>/dev/null || echo missing)" >&2
    exit 1
  fi
}

kill_port_if_needed() {
  local port="$1"
  local pids
  pids="$(lsof -ti ":$port" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs -r kill
    sleep 1
  fi
}

start_session() {
  ensure_tmux
  ensure_node
  mkdir -p "$REPO_DIR/data/logs"

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "tmux session already exists: $SESSION_NAME"
    status_session
    return 0
  fi

  kill_port_if_needed "$SERVER_PORT"
  kill_port_if_needed "$CLIENT_PORT"

  tmux new-session -d -s "$SESSION_NAME" -c "$REPO_DIR"
  tmux send-keys -t "$SESSION_NAME":0.0 "export PATH=$NODE22_BIN:\$PATH; cd '$REPO_DIR'; pnpm dev:server 2>&1 | tee -a '$SERVER_LOG'" C-m
  tmux split-window -h -t "$SESSION_NAME":0 -c "$REPO_DIR"
  tmux send-keys -t "$SESSION_NAME":0.1 "export PATH=$NODE22_BIN:\$PATH; cd '$REPO_DIR'; pnpm dev:client 2>&1 | tee -a '$CLIENT_LOG'" C-m
  tmux select-layout -t "$SESSION_NAME":0 tiled >/dev/null

  echo "started tmux session: $SESSION_NAME"
  status_session
}

stop_session() {
  ensure_tmux
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
  fi
  kill_port_if_needed "$SERVER_PORT"
  kill_port_if_needed "$CLIENT_PORT"
  echo "stopped tmux session: $SESSION_NAME"
}

status_session() {
  ensure_tmux
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "tmux: running ($SESSION_NAME)"
    tmux list-panes -t "$SESSION_NAME":0 -F '#{pane_index} #{pane_current_command} #{pane_dead}'
  else
    echo "tmux: not running"
  fi

  if curl -fsS "http://127.0.0.1:$SERVER_PORT/api/health" >/dev/null 2>&1; then
    echo "server: up ($SERVER_PORT)"
  else
    echo "server: down ($SERVER_PORT)"
  fi

  if curl -fsS "http://localhost:$CLIENT_PORT" >/dev/null 2>&1; then
    echo "client: up ($CLIENT_PORT)"
  else
    echo "client: down ($CLIENT_PORT)"
  fi
}

logs_session() {
  echo "server log: $SERVER_LOG"
  tail -n 40 "$SERVER_LOG" 2>/dev/null || true
  echo
  echo "client log: $CLIENT_LOG"
  tail -n 40 "$CLIENT_LOG" 2>/dev/null || true
}

attach_session() {
  ensure_tmux
  exec tmux attach -t "$SESSION_NAME"
}

case "${1:-start}" in
  start)
    start_session
    ;;
  stop)
    stop_session
    ;;
  restart)
    stop_session
    start_session
    ;;
  status)
    status_session
    ;;
  logs)
    logs_session
    ;;
  attach)
    attach_session
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|attach}" >&2
    exit 1
    ;;
esac
