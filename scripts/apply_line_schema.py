"""Verify the LINE schema, or apply it using the Supabase Management API.

An already-applied schema can be verified with SUPABASE_SERVICE_KEY, allowing
SQL Editor migrations without granting database access to the deployment PAT.
Reports sanitized error messages, never credentials or query response data.
API reference: https://supabase.com/docs/reference/api/v1-run-a-query
"""
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

SCHEMA_VERSION = '2026-10-21.1'  # Bump together with line_schema_version() for SQL changes.


def schema_is_current(ref):
    key = os.environ.get('SUPABASE_SERVICE_KEY', '').strip()
    if not key:
        return False
    request = urllib.request.Request(
        f'https://{ref}.supabase.co/rest/v1/rpc/line_schema_version',
        data=b'{}',
        headers={'apikey': key, 'Authorization': f'Bearer {key}',
                 'Content-Type': 'application/json'}, method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status == 200 and json.loads(response.read(4096)) == SCHEMA_VERSION
    except (urllib.error.URLError, TimeoutError, ValueError):
        # Missing RPC, authentication failures and network errors never count as ready.
        return False


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
    if not re.fullmatch(r'[a-z0-9]{20}', ref):
        fail('PROJECT_REF must be the 20-character Supabase project reference')
    if schema_is_current(ref):
        print(f'LINE schema {SCHEMA_VERSION} already applied; database check passed')
        return
    if not token:
        fail('Missing GitHub Actions secret SUPABASE_ACCESS_TOKEN')
    if re.search(r'\s', token):
        fail('SUPABASE_ACCESS_TOKEN contains unexpected whitespace; check the saved secret')
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
        hint = (' Apply supabase/schema_line.sql in the project SQL Editor, then rerun '
                'with SUPABASE_SERVICE_KEY configured.' if error.code == 403 else '')
        fail(f'LINE migration failed: HTTP {error.code}. {error_reason(error, token)}{hint}')
    except (urllib.error.URLError, TimeoutError):
        fail('LINE migration connection failed; deployment stopped. The transaction can be retried.')
    print('LINE schema applied successfully')


if __name__ == '__main__':
    main()
