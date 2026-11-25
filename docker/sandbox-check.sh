#!/bin/bash
# Checks the sandbox rules (docker/sudoers, docker/agentdeck-sandbox) inside the image, as the
# server user. Needs two git repos /repos/alpha and /repos/beta. For example:
#   docker run --rm --init --cap-add NET_ADMIN -u root --entrypoint bash -v "$PWD/docker/sandbox-check.sh:/check.sh:ro" <image> -c \
#     'mkdir -p /repos/alpha /repos/beta && git init -q /repos/alpha && git init -q /repos/beta &&
#      chown -R node:node /repos && su node -s /bin/bash /check.sh'
# Every line must say PASS. It writes to /data, so never run it against a real data volume.
H=/usr/local/sbin/agentdeck-sandbox
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; }
expect_fail() { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
expect_ok() { local d=$1; shift; if out=$("$@" 2>&1); then ok "$d"; else bad "$d: $out"; fi; }

echo secret > /data/agentdeck.db; chmod 600 /data/agentdeck.db
echo key > /data/secret.key; chmod 600 /data/secret.key

expect_ok   "ensure ALPHA with repo" sudo -n $H ensure ALPHA /repos/alpha
expect_ok   "ensure BETA with repo"  sudo -n $H ensure BETA /repos/beta
expect_fail "BETA cannot take ALPHA's repo" sudo -n $H ensure BETA /repos/alpha
expect_fail "repo outside /repos rejected" sudo -n $H ensure ALPHA /etc
expect_fail "path traversal rejected" sudo -n $H ensure ALPHA /repos/../etc
expect_fail "bad key rejected" sudo -n $H ensure 'a;id' 
expect_fail "lowercase key rejected" sudo -n $H ensure alpha

A="sudo -n -E -u ad-alpha --"
expect_fail "project user cannot read the DB"        $A cat /data/agentdeck.db
expect_fail "project user cannot read secret.key"    $A cat /data/secret.key
expect_fail "project user has no sudo"               $A sudo -n true
expect_fail "project user cannot run helper"         $A sudo -n $H install curl
expect_fail "ALPHA cannot read BETA's repo"          $A ls /repos/beta
expect_fail "ALPHA cannot read BETA's worktrees"     $A ls /data/worktrees/BETA
expect_fail "ALPHA cannot read BETA's home"          $A ls /home/ad-beta
expect_ok   "ALPHA works in its repo" $A git -C /repos/alpha status --short
expect_ok   "ALPHA writes its worktree" $A sh -c 'echo x > /data/worktrees/ALPHA/f && test "$(stat -c %G /data/worktrees/ALPHA/f)" = node'
expect_ok   "umask gives the server group write" $A sh -c 'test "$(stat -c %a /data/worktrees/ALPHA/f)" = 660'
expect_ok   "server reads project files" cat /data/worktrees/ALPHA/f
expect_ok   "server writes project files" sh -c 'echo y >> /data/worktrees/ALPHA/f'
expect_fail "node cannot sudo as root generally" sudo -n true
expect_fail "node cannot sudo as an arbitrary user" sudo -n -u nobody true
expect_ok   "env passes through (-E)" sh -c 'FOO=bar sudo -n -E -u ad-alpha -- sh -c "test \$FOO = bar"'
expect_fail "LD_PRELOAD does not pass" sh -c 'LD_PRELOAD=/x.so sudo -n -E -u ad-alpha -- sh -c "test -n \"\$LD_PRELOAD\""'
expect_ok   "stdout is a pipe, not a pty" sh -c 'test "$(sudo -n -E -u ad-alpha -- sh -c "test -t 1 && echo tty || echo pipe")" = pipe'

# kill: a group the server started vs. anything else
setsid sudo -n -E -u ad-alpha -- sh -c 'sleep 300 & sleep 300 & wait' &
sleep 1
PG=$(ps -e -o pid=,comm=,ppid= | awk -v me=$$ '$2=="sudo" && $3==me {print $1}' | head -n1)
[ -z "$PG" ] && PG=$(pgrep -n -x sudo)
expect_fail "kill of a foreign pid rejected" sudo -n $H kill 1
expect_fail "kill of garbage rejected" sudo -n $H kill '1;id'
echo "group leader $PG, members: $(ps -e -o pgid=,user=,comm= | awk -v g=$PG '$1==g' | tr '\n' ' ')"
sudo -n $H kill "$PG"; sleep 1
# Zombies only wait for pid 1 to reap them (tini does in production); they no longer run.
if [ -z "$(ps -e -o pgid=,user=,stat= | awk -v g=$PG '$1==g && $2=="ad-alpha" && $3 !~ /^Z/')" ]; then ok "kill stops the whole group"; else bad "group still alive: $(ps -e -o pgid=,user=,stat=,comm= | awk -v g=$PG '$1==g')"; fi
expect_fail "install rejects options" sudo -n $H install -- '-oAPT::Update::Pre-Invoke::=id'
expect_fail "install rejects odd names" sudo -n $H install 'curl;id'
expect_ok   "install works" sudo -n $H install jq
expect_ok   "installed package usable by project user" $A jq --version

# egress: a project on the allowlist reaches only loopback, the others stay open.
B="sudo -n -E -u ad-beta --"
IP=$(getent hosts "$(hostname)" | awk '{ print $1; exit }')
# A client that closes at once resets the socket; without an error handler that would end the listener.
node -e 'require("net").createServer((s) => { s.on("error", () => {}); s.end("hi") }).listen(9911, "0.0.0.0")' &
LISTENER=$!
sleep 1
reach() { local host=$1; shift; "$@" bash -c "exec 3<>/dev/tcp/$host/9911"; }
expect_fail "egress rejects a bad mode" sudo -n $H egress ALPHA wide
expect_fail "egress rejects a bad key" sudo -n $H egress 'A;id' open
expect_fail "egress rejects a project without user" sudo -n $H egress NOPE allowlist
expect_fail "egress rejects extra arguments" sudo -n $H egress ALPHA allowlist x
expect_ok   "ALPHA reaches the container IP while open ($IP)" reach "$IP" $A
expect_ok   "egress allowlist for ALPHA" sudo -n $H egress ALPHA allowlist
expect_ok   "egress allowlist again (idempotent)" sudo -n $H egress ALPHA allowlist
expect_fail "ALPHA on the allowlist cannot reach the container IP" reach "$IP" $A
expect_fail "ALPHA on the allowlist has no DNS" $A getent hosts example.com
expect_ok   "ALPHA on the allowlist reaches 127.0.0.1" reach 127.0.0.1 $A
expect_ok   "BETA stays open" reach "$IP" $B
expect_ok   "the server stays open" reach "$IP"
expect_ok   "egress open for ALPHA" sudo -n $H egress ALPHA open
expect_ok   "ALPHA reaches the container IP again" reach "$IP" $A
expect_ok   "egress open again (idempotent)" sudo -n $H egress ALPHA open
kill $LISTENER
