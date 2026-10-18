import io
import json
import urllib.error

import pytest

from scripts import apply_line_schema as migration


@pytest.fixture(autouse=True)
def isolated_credentials(monkeypatch):
    monkeypatch.setenv('PROJECT_REF', 'jxpnamaomzztqqahixvp')
    monkeypatch.delenv('SUPABASE_SERVICE_KEY', raising=False)


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


def test_verified_schema_skips_management_api_without_pat(monkeypatch, capsys):
    monkeypatch.setenv('SUPABASE_SERVICE_KEY', 'fake-service-key')
    monkeypatch.delenv('SUPABASE_ACCESS_TOKEN', raising=False)
    calls = []
    class Response(io.BytesIO):
        status = 200
    def accept(request, **kwargs):
        calls.append(request.full_url)
        assert request.get_header('Apikey') == 'fake-service-key'
        assert request.full_url == 'https://jxpnamaomzztqqahixvp.supabase.co/rest/v1/rpc/line_schema_version'
        return Response(json.dumps(migration.SCHEMA_VERSION).encode())
    monkeypatch.setattr(migration.urllib.request, 'urlopen', accept)
    migration.main()
    assert len(calls) == 1
    assert 'already applied' in capsys.readouterr().out
    sql = (migration.Path(migration.__file__).resolve().parents[1] / 'supabase/schema_line.sql').read_text()
    assert f"select '{migration.SCHEMA_VERSION}'::text" in sql


@pytest.mark.parametrize('result', ['old-version', None, {'version': migration.SCHEMA_VERSION}, 'invalid-json', 401, 404, 500, 'timeout'])
def test_unverified_schema_cannot_skip_migration(monkeypatch, result):
    monkeypatch.setenv('SUPABASE_SERVICE_KEY', 'fake-service-key')
    monkeypatch.delenv('SUPABASE_ACCESS_TOKEN', raising=False)
    class Response(io.BytesIO):
        status = 200
    def reject(request, **kwargs):
        if isinstance(result, int):
            raise urllib.error.HTTPError(request.full_url, result, 'Error', {}, io.BytesIO(b'private'))
        if result == 'timeout':
            raise TimeoutError('private')
        return Response(b'invalid' if result == 'invalid-json' else json.dumps(result).encode())
    monkeypatch.setattr(migration.urllib.request, 'urlopen', reject)
    with pytest.raises(SystemExit, match='Missing GitHub Actions secret'):
        migration.main()
