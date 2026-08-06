#!/bin/bash
# solidpay-haproxy.sh — wire https://<host> through HAProxy to the local
# solidpay node on 127.0.0.1:3480. Idempotent; backs up the config and
# restores it if the haproxy check fails.
#
#   sudo bash app-haproxy.sh <host> <pem-path> [port] [name] [email]
#   e.g. sudo bash app-haproxy.sh scry.melvincarvalho.com /etc/ssl/certs/scry.melvincarvalho.com.pem 3490 scry
set -euo pipefail
HOST=${1:?usage: app-haproxy.sh <host> <pem-path> [port] [name] [email]}
PEM=${2:?pem path required}
APP_PORT=${3:-3480}
APP_NAME=${4:-solidpay}
EMAIL=${5:-melvincarvalho@gmail.com}
CFG=/etc/haproxy/haproxy.cfg
BAK=$CFG.bak-solidpay-$(date +%s)
cp "$CFG" "$BAK"
echo "backup: $BAK"

check_or_restore() {
  if ! haproxy -c -f "$CFG" >/dev/null 2>&1; then
    echo "haproxy check FAILED — restoring backup" >&2
    cp "$BAK" "$CFG"
    haproxy -c -f "$CFG" >/dev/null && systemctl reload haproxy
    exit 1
  fi
  systemctl reload haproxy
}

# ---- phase 1: ACME routing on :80 (skip if the config already has one) ----
python3 - "$HOST" <<'PY'
import re, sys
cfg = '/etc/haproxy/haproxy.cfg'
s = open(cfg).read()
if '/.well-known/acme-challenge/' in s:
    # Repair the redirect-condition algebra wherever an acme exemption was
    # written in the broken `unless { ssl_fc } !<acl>` form (terms AND, so
    # that still redirects plain-http acme). Covers our own acl name AND any
    # pre-existing one (e.g. is_acme_challenge).
    fixed = re.sub(r'unless \{ ssl_fc \} !(\S*acme\S*)', r'if !{ ssl_fc } !\1', s)
    if fixed != s:
        open(cfg, 'w').write(fixed)
        print('repaired redirect condition (unless -> if !ssl)')
    else:
        print('acme routing already present — keeping it')
    sys.exit(0)
# find the frontend section that binds :80
sections = re.split(r'(?m)^(?=(?:frontend|backend|listen|defaults|global)\b)', s)
for i, sec in enumerate(sections):
    if sec.startswith('frontend') and re.search(r'(?m)^\s*bind\s+\*?:80\b', sec):
        lines = sec.splitlines(keepends=True)
        # insert after the last bind line
        last_bind = max(j for j, l in enumerate(lines) if re.match(r'\s*bind\s', l))
        indent = re.match(r'(\s*)', lines[last_bind]).group(1)
        ins = (f"{indent}acl solidpay_acme path_beg /.well-known/acme-challenge/\n"
               f"{indent}use_backend solidpay_acme if solidpay_acme\n")
        lines.insert(last_bind + 1, ins)
        # exempt acme from any http->https redirect in this section.
        # NOTE the condition algebra: terms AND together, so the safe form is
        # `if !{ ssl_fc } !solidpay_acme` (redirect only when plain-http AND
        # not acme). Appending to `unless { ssl_fc }` would make the https
        # acme request redirect to itself — a loop.
        for j, l in enumerate(lines):
            if 'redirect scheme https' in l and 'acme' not in l:
                nl = l.replace('unless { ssl_fc }', 'if !{ ssl_fc }')
                lines[j] = nl.rstrip('\n') + ' !solidpay_acme\n'
        sections[i] = ''.join(lines)
        break
else:
    sys.exit('no :80 frontend found')
s = ''.join(sections)
s += '\nbackend solidpay_acme\n    server certbot 127.0.0.1:8888\n'
open(cfg, 'w').write(s)
print('acme routing added (:80 -> 127.0.0.1:8888)')
PY
check_or_restore

# ---- phase 2: certificate (standalone certbot behind the acme route) ------
if [ ! -d "/etc/letsencrypt/live/$HOST" ]; then
  certbot certonly --standalone --http-01-port 8888 -d "$HOST" -n --agree-tos -m "$EMAIL"
fi
mkdir -p "$(dirname "$PEM")"
cat "/etc/letsencrypt/live/$HOST/fullchain.pem" "/etc/letsencrypt/live/$HOST/privkey.pem" > "$PEM"
chmod 600 "$PEM"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > "/etc/letsencrypt/renewal-hooks/deploy/solidpay-$HOST.sh" <<EOF
#!/bin/sh
cat /etc/letsencrypt/live/$HOST/fullchain.pem /etc/letsencrypt/live/$HOST/privkey.pem > $PEM
systemctl reload haproxy
EOF
chmod +x "/etc/letsencrypt/renewal-hooks/deploy/solidpay-$HOST.sh"
echo "cert ready: $PEM (renewal hook installed)"

# ---- phase 3: serve the cert + route the host to the node -----------------
python3 - "$HOST" "$PEM" "$APP_PORT" "$APP_NAME" <<'PY'
import re, sys
host, pem = sys.argv[1], sys.argv[2]
app_port, app_name = sys.argv[3], sys.argv[4]
cfg = '/etc/haproxy/haproxy.cfg'
s = open(cfg).read()
if f'hdr(host) -i {host}' in s:
    print('host routing already present')
    sys.exit(0)
sections = re.split(r'(?m)^(?=(?:frontend|backend|listen|defaults|global)\b)', s)
for i, sec in enumerate(sections):
    if sec.startswith('frontend') and re.search(r'(?m)^\s*bind\s+\S*:443\s.*ssl', sec):
        lines = sec.splitlines(keepends=True)
        for j, l in enumerate(lines):
            m = re.match(r'(\s*)(bind\s+\S*:443\s.*ssl.*)', l)
            if not m: continue
            indent, bindline = m.group(1), m.group(2).rstrip()
            # if the bind already reads a certs DIRECTORY that contains our pem,
            # nothing to add; else append our pem as an additional crt (SNI picks it)
            dirmatch = re.search(r'crt\s+(\S+/)\s*$', bindline + ' ')
            served = False
            for cm in re.finditer(r'crt\s+(\S+)', bindline):
                p = cm.group(1)
                if p == pem or (p.endswith('/') and pem.startswith(p)): served = True
            if not served:
                lines[j] = indent + bindline + f' crt {pem}\n'
            break
        # route the host: append at the end of the section (before next section)
        indent = '    '
        end = len(lines)
        while end > 0 and lines[end-1].strip() == '': end -= 1
        lines.insert(end, f"{indent}acl is_{app_name} hdr(host) -i {host}\n{indent}use_backend {app_name} if is_{app_name}\n")
        sections[i] = ''.join(lines)
        break
else:
    sys.exit('no :443 ssl frontend found')
s = ''.join(sections)
if re.search(rf'(?m)^backend {app_name}\b', s) is None:
    s += f'\nbackend {app_name}\n    server {app_name} 127.0.0.1:{app_port} check\n'
open(cfg, 'w').write(s)
print(f'routed {host} -> 127.0.0.1:{app_port} (backend {app_name})')
PY
check_or_restore

echo "✓ https://$HOST is live"
