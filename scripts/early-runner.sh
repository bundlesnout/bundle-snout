#!/bin/bash
# Keeps the early-volume PAPER runner alive (restarts on crash). Start: nohup scripts/early-runner.sh >/dev/null 2>&1 &
cd /workspace/sniff
exec 9>/tmp/early-runner.lock; flock -n 9 || { echo "already running"; exit 0; }
while true; do node scripts/early-runner.js >> /workspace/agentdata/early-runner.log 2>&1; sleep 5; done
