import io
import json
import urllib.error

import pytest

from scripts import apply_line_schema as migration


def test_migration_reports_api_error_without_exposing_token(monkeypatch, capsys):
    token = 'fake-private-token'
    monkeypatch.setenv('SUPABASE_ACCESS_TOKEN', token)
    monkeypatch.setenv('PROJECT_REF', 'jxpnamaomzztqqahixvp')
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    def reject(request, **kwargs):
        assert request.get_header('Authorization') == 'Bearer ' + token
        assert 'create table' in json.loads(request.data)['query']
        raise urllib.error.HTTPError(request.full_url, 403, 'Forbidden', {},
                                     io.BytesIO(json.dumps({'message': 'Permission missing: ' + token}).encode()))
    monkeypatch.setattr(migration.urllib.request, 'urlopen', reject)
    with pytest.raises(SystemExit, match='HTTP 403') as error:
        migration.main()
    output = capsys.readouterr().out
    assert '::error title=LINE database migration::' in output
    assert 'Permission missing' in output and token not in output
    assert token not in str(error.value)


def test_migration_missing_token_stops_before_request(monkeypatch, capsys):
    monkeypatch.delenv('SUPABASE_ACCESS_TOKEN', raising=False)
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    with pytest.raises(SystemExit, match='Missing GitHub Actions secret'):
        migration.main()
    assert 'SUPABASE_ACCESS_TOKEN' in capsys.readouterr().out


def test_migration_success_and_non_json_error(monkeypatch, capsys):
    monkeypatch.setenv('SUPABASE_ACCESS_TOKEN', ' fake-private-token\n')
    monkeypatch.setenv('PROJECT_REF', 'jxpnamaomzztqqahixvp')
    class Response:
        status = 201
        def __enter__(self): return self
        def __exit__(self, *args): pass
    def accept(request, **kwargs):
        assert request.get_header('Authorization') == 'Bearer fake-private-token'
        return Response()
    monkeypatch.setattr(migration.urllib.request, 'urlopen', accept)
    migration.main()
    assert 'applied successfully' in capsys.readouterr().out
    error = urllib.error.HTTPError('https://example.invalid', 500, 'Error', {}, io.BytesIO(b'<html>private server data</html>'))
    assert migration.error_reason(error, 'fake') == 'Non-JSON error response; check API availability'
