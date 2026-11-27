"""Tes halaman utama: tabel Pipeline keputusan (G0-G9) harus ada di index.html hasil render."""
from scalp.report import write_site


def test_index_memuat_tabel_pipeline(tmp_path):
    write_site(tmp_path, {"results": [], "signals": [], "stats": {}, "generated_at": "2026-01-01T00:00:00+00:00"})
    html = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert "Pipeline keputusan" in html
    for g in range(10):
        assert f"<td>G{g}</td>" in html
    assert "__DATA__" not in html
