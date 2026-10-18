"""Apply the additive, idempotent LINE schema using the Supabase Management API.

Requires SUPABASE_ACCESS_TOKEN and PROJECT_REF. Does not print credentials or response data.
API reference: https://supabase.com/docs/reference/api/v1-run-a-query
"""
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


def main():
    token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
    ref = os.environ.get('PROJECT_REF', '')
    if not token or not re.fullmatch(r'[a-z0-9]{20}', ref):
        raise SystemExit('SUPABASE_ACCESS_TOKEN and a valid PROJECT_REF are required')
    sql = (Path(__file__).resolve().parents[1] / 'supabase/schema_line.sql').read_text()
    request = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{ref}/database/query',
        data=json.dumps({'query': sql, 'read_only': False}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status not in (200, 201):
                raise SystemExit(f'LINE migration failed: HTTP {response.status}')
    except urllib.error.HTTPError as error:
        raise SystemExit(f'LINE migration failed: HTTP {error.code}. Check project/token permissions; deployment stopped.') from None
    except urllib.error.URLError:
        raise SystemExit('LINE migration connection failed; deployment stopped. The transaction can be retried.') from None
    print('LINE schema applied successfully')


if __name__ == '__main__':
    main()
