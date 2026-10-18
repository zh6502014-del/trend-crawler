"""Apply the additive, idempotent LINE schema using the Supabase Management API.

Requires SUPABASE_ACCESS_TOKEN and PROJECT_REF. Reports sanitized error messages,
never credentials or successful query response data.
API reference: https://supabase.com/docs/reference/api/v1-run-a-query
"""
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


def fail(message):
    if os.getenv('GITHUB_ACTIONS') == 'true':
        escaped = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print(f'::error title=LINE database migration::{escaped}', flush=True)
    raise SystemExit(message)


def error_reason(error, token):
    try:
        data = json.loads(error.read(4096))
        reason = data.get('message') or data.get('error') or data.get('code')
        if not isinstance(reason, str):
            return 'No text error message returned'
        reason = reason.replace(token, '[redacted]') if token else reason
        reason = re.sub(r'eyJ[\w-]+\.[\w-]+\.[\w-]+', '[redacted]', reason)
        return ' '.join(reason.split())[:500]
    except (ValueError, AttributeError):
        return 'Non-JSON error response; check API availability'


def main():
    token = os.environ.get('SUPABASE_ACCESS_TOKEN', '').strip()
    ref = os.environ.get('PROJECT_REF', '').strip()
    if not token:
        fail('Missing GitHub Actions secret SUPABASE_ACCESS_TOKEN')
    if re.search(r'\s', token):
        fail('SUPABASE_ACCESS_TOKEN contains unexpected whitespace; check the saved secret')
    if not re.fullmatch(r'[a-z0-9]{20}', ref):
        fail('PROJECT_REF must be the 20-character Supabase project reference')
    sql = (Path(__file__).resolve().parents[1] / 'supabase/schema_line.sql').read_text()
    request = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{ref}/database/query',
        data=json.dumps({'query': sql, 'read_only': False}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
                 'User-Agent': 'trend-crawler/line-deploy'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status not in (200, 201):
                fail(f'LINE migration failed: HTTP {response.status}')
    except urllib.error.HTTPError as error:
        fail(f'LINE migration failed: HTTP {error.code}. {error_reason(error, token)}')
    except urllib.error.URLError:
        fail('LINE migration connection failed; deployment stopped. The transaction can be retried.')
    print('LINE schema applied successfully')


if __name__ == '__main__':
    main()
