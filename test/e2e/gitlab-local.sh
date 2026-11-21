#!/usr/bin/env bash
# M6: a local GitLab CE for the end-to-end run (Colima + Docker on macOS). Not part of the plugin; kept so the run can be
# repeated. Secrets go to ~/.config/dev-process/ (mode 600) and are never printed.
#
#   test/e2e/gitlab-local.sh bootstrap   # after `docker run … gitlab/gitlab-ce` is healthy: root token, settings, users, runner
#   test/e2e/gitlab-local.sh status
#
# Layout: GitLab publishes http://localhost:8929 (its external_url too); the runner and every job container use the host
# network of the Colima VM, so `localhost:8929` is GitLab for the Mac, the runner, the jobs and GitLab's own webhooks alike.
set -euo pipefail

CONF="$HOME/.config/dev-process"
URL="http://localhost:8929"
API="$URL/api/v4"
umask 077
mkdir -p "$CONF"

rand() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString("base64url"))' "$1"; }
root_token() { cat "$CONF/gitlab-local-token"; }
api() { # api METHOD PATH [curl args…]
  local m="$1" p="$2"; shift 2
  curl -sf -m 30 -X "$m" -H "PRIVATE-TOKEN: $(root_token)" "$API$p" "$@"
}

wait_healthy() {
  echo "waiting for GitLab at $URL …"
  for _ in $(seq 1 90); do
    if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL/users/sign_in")" = 200 ]; then echo "GitLab is up"; return 0; fi
    sleep 10
  done
  echo "GitLab did not come up" >&2
  return 1
}

bootstrap() {
  wait_healthy
  # 1. root's token (api + sudo: the run acts as alice / bob through the Sudo header), set through Rails so its value
  #    never passes through a web page.
  if [ ! -s "$CONF/gitlab-local-token" ]; then
    printf 'glpat-%s' "$(rand 24)" > "$CONF/gitlab-local-token"
  fi
  docker exec -e TOK="$(root_token)" gitlab gitlab-rails runner '
    u = User.find_by_username("root")
    u.personal_access_tokens.where(name: "dev-process-m6").each(&:revoke!)
    t = u.personal_access_tokens.new(name: "dev-process-m6", scopes: %w[api sudo admin_mode], expires_at: 60.days.from_now)
    t.set_token(ENV.fetch("TOK"))
    t.save!
    puts "root token: ok"
  '
  # 2. Instance settings: webhooks may call this instance (the trigger), no sign-up, no Auto DevOps.
  api PUT /application/settings \
    --data allow_local_requests_from_web_hooks_and_services=true \
    --data signup_enabled=false \
    --data auto_devops_enabled=false >/dev/null && echo "settings: ok"
  # 3. Test users (no mail server: nothing leaves this machine).
  for u in alice bob; do
    if [ "$(api GET "/users?username=$u" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')" = 0 ]; then
      api POST /users --data-urlencode "username=$u" --data-urlencode "name=$u" --data-urlencode "email=$u@example.test" \
        --data-urlencode "password=$(rand 18)Aa1!" --data skip_confirmation=true >/dev/null
      echo "user $u: created"
    else
      echo "user $u: exists"
    fi
  done
  # 4. An instance runner: Docker executor on the VM's host network, default image node:24.
  if ! docker ps --format '{{.Names}}' | grep -qx gitlab-runner; then
    docker run -d --name gitlab-runner --restart unless-stopped --network host \
      -v /var/run/docker.sock:/var/run/docker.sock -v gitlab-runner-config:/etc/gitlab-runner gitlab/gitlab-runner:latest >/dev/null
  fi
  if ! docker exec gitlab-runner grep -q 'url = "http://localhost:8929' /etc/gitlab-runner/config.toml 2>/dev/null; then
    local rt
    rt="$(api POST /user/runners --data runner_type=instance_type --data run_untagged=true --data-urlencode "description=m6-docker" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))')"
    docker exec gitlab-runner gitlab-runner register --non-interactive --url "$URL" --token "$rt" \
      --executor docker --docker-image node:24 --docker-network-mode host --docker-pull-policy if-not-present >/dev/null 2>&1
    echo "runner: registered"
  else
    echo "runner: registered already"
  fi
}

status() {
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
  echo "version: $(api GET /version | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(o.version)})')"
  api GET "/runners/all?per_page=20" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s))console.log(`runner #${r.id} ${r.description} ${r.status}`)})'
}

case "${1:-}" in
  bootstrap) bootstrap ;;
  status) status ;;
  *) echo "usage: $0 bootstrap | status" >&2; exit 2 ;;
esac
