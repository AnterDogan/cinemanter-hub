"""Stellt Cloudflare Access vor demxane.com (den Dienste-Hub).

Aufruf:
  CF_TOKEN=... python3 cf-hub-access.py --dry-run
  CF_TOKEN=... python3 cf-hub-access.py
  CF_TOKEN=... python3 cf-hub-access.py --google-client-id ID --google-client-secret SECRET

Der API-Token braucht: Account → "Access: Apps and Policies: Edit" und
"Access: Organizations, Identity Providers, and Groups: Edit" (nur für den Google-Login).

Was passiert:
  1. Login-Verfahren: "One-time PIN" (Code per E-Mail) wird angelegt, falls es fehlt.
     Mit --google-client-id/-secret zusätzlich "Google" (Anmeldung mit dem Google-Konto).
  2. Access-App "demxane" für demxane.com, Sitzung 30 Tage, nur anter.ms.dogan@gmail.com.
  3. Access-App "demxane push" für demxane.com/api/push mit Bypass, damit der Mini seine
     Auslastung weiter melden kann (der Endpunkt prüft selbst den PUSH_TOKEN).
"""
import argparse, json, os, sys, urllib.request, urllib.error

API = "https://api.cloudflare.com/client/v4"
ACCOUNT = "fb9f2ff4be9cf8994dd7696b8cb011b7"
HOST = "demxane.com"
ALLOW_EMAILS = ["anter.ms.dogan@gmail.com"]
SESSION = "720h"  # 30 Tage

parser = argparse.ArgumentParser()
parser.add_argument("--dry-run", action="store_true")
parser.add_argument("--google-client-id")
parser.add_argument("--google-client-secret")
args = parser.parse_args()
DRY = args.dry_run
TOKEN = os.environ.get("CF_TOKEN") or sys.exit("CF_TOKEN fehlt (Umgebungsvariable)")


def cf(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        d = json.loads(e.read().decode() or "{}")
    if not d.get("success"):
        raise SystemExit(f"API-Fehler bei {method} {path}: {d.get('errors')}")
    return d["result"]


def do(label, method, path, body):
    if DRY:
        print(f"  [dry-run] {label}:", json.dumps(body, ensure_ascii=False)[:300])
        return None
    res = cf(method, path, body)
    print(f"  {label}: ok")
    return res


print("=== Token ===")
print("  Status:", cf("GET", "/user/tokens/verify")["status"])

print("=== Login-Verfahren ===")
idps = cf("GET", f"/accounts/{ACCOUNT}/access/identity_providers")
for i in idps:
    print(f"  vorhanden: {i['name']} ({i['type']})")
idp_ids = []
otp = next((i for i in idps if i["type"] == "onetimepin"), None)
if otp:
    idp_ids.append(otp["id"])
else:
    res = do("One-time PIN anlegen", "POST", f"/accounts/{ACCOUNT}/access/identity_providers",
             {"name": "One-time PIN", "type": "onetimepin", "config": {}})
    if res:
        idp_ids.append(res["id"])
google = next((i for i in idps if i["type"] == "google"), None)
if google:
    idp_ids.append(google["id"])
elif args.google_client_id and args.google_client_secret:
    res = do("Google anlegen", "POST", f"/accounts/{ACCOUNT}/access/identity_providers",
             {"name": "Google", "type": "google",
              "config": {"client_id": args.google_client_id, "client_secret": args.google_client_secret}})
    if res:
        idp_ids.append(res["id"])
else:
    print("  Google: nicht eingerichtet (später mit --google-client-id/--google-client-secret nachholen)")

print("=== Access-App für den Hub ===")
apps = cf("GET", f"/accounts/{ACCOUNT}/access/apps")
for a in apps:
    print(f"  vorhanden: {a.get('name')} | {a.get('domain')}")

hub_body = {
    "name": "demxane", "type": "self_hosted", "domain": HOST, "self_hosted_domains": [HOST],
    "session_duration": SESSION, "app_launcher_visible": False, "auto_redirect_to_identity": False,
    "allowed_idps": idp_ids,
    "policies": [{"name": "Anter", "decision": "allow", "precedence": 1,
                  "include": [{"email": {"email": e}} for e in ALLOW_EMAILS]}],
}
hub = next((a for a in apps if a.get("domain") == HOST), None)
if hub:
    print(f"  App existiert bereits: {hub['name']} ({hub['id'][:8]}…)")
    if sorted(hub.get("allowed_idps") or []) != sorted(idp_ids):
        do("Login-Verfahren der App aktualisieren", "PUT", f"/accounts/{ACCOUNT}/access/apps/{hub['id']}",
           {k: v for k, v in hub_body.items() if k != "policies"})
else:
    do("App demxane.com anlegen (Policy: nur " + ", ".join(ALLOW_EMAILS) + ")", "POST",
       f"/accounts/{ACCOUNT}/access/apps", hub_body)

print("=== Ausnahme für den Mini (/api/push) ===")
push_domain = f"{HOST}/api/push"
push = next((a for a in apps if a.get("domain") == push_domain), None)
if push:
    print(f"  App existiert bereits: {push['name']} ({push['id'][:8]}…)")
else:
    do("Bypass-App für " + push_domain + " anlegen", "POST", f"/accounts/{ACCOUNT}/access/apps",
       {"name": "demxane push", "type": "self_hosted", "domain": push_domain, "self_hosted_domains": [push_domain],
        "session_duration": "24h", "app_launcher_visible": False,
        "policies": [{"name": "Mini darf melden", "decision": "bypass", "precedence": 1,
                      "include": [{"everyone": {}}]}]})

print("fertig" + (" (dry-run, nichts geändert)" if DRY else ""))
