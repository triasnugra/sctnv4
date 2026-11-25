# monitorsctn
Monitor kinerja & evaluasi mesin analisis **scalping** crypto: `sctn`, `sctnv2`, `sctnv3`, `sctnv4` (dan mesin berikutnya).
Situs: https://triasnugra.github.io/msctn/ · Struktur sama dengan `monitortn` (Node 22, GitHub Actions + Pages), tetapi seluruh metriknya untuk scalping.

## Pasang
1. Buat repo `msctn`, upload semua file (GitHub web UI), Settings → Pages → Source: **GitHub Actions**.
2. Repo mesin privat? Buat token (read contents) → simpan sebagai secret `MONITOR_TOKEN`. Repo publik: tidak perlu (monitor membaca juga dari `https://triasnugra.github.io/<mesin>/data/...`).
3. Actions → monitor → Run workflow. Build otomatis tiap 30 menit.
4. Mesin baru berformat sctn: tambahkan satu blok di `engines` pada `config.json`. Mesin berformat sctnv4 (Python, `history.json`): blok dengan `"fmt": "history"` (lihat bawah).

## Yang dibaca dari tiap mesin (tidak ada yang diubah di mesin)
`output/signal_log.csv`, `output/forward_test.json`, `output/backtest/summary.json`, `output/backtest/trades.csv`, `output/universe.json`.

## Beda dengan monitortn (swing)
| Hal | monitortn (swing) | monitorsctn (scalping) |
|---|---|---|
| Sumber | `data/journal.json` | log sinyal + forward test + backtest mesin sctn |
| Satuan waktu | hari / minggu | jam; durasi trade, tunggu isi limit, sesi (Asia/Eropa/AS) |
| Hasil | TP / SL / kedaluwarsa | LOSS / TP1_BE / TP2 / TIMEOUT, R parsial (60% di TP1) |
| Biaya | 0,2% | 0,15% (bisa diubah); stop scalping ±0,7% → biaya ≈ 0,2R per trade |
| Kunci evaluasi | win rate & R | **corong sinyal→terisi→selesai** (limit yang tak terisi), biaya impas, durasi |
| Uji silang | tidak ada | hitung ulang trade forward dengan **candle 1 menit** (simulator 15m mesin ambigu bila stop & TP di candle sama) |

## Isi dashboard
- **Ringkasan & gerbang kelayakan** (forward saja): trade ≥150, minggu ≥20, CI95 bawah > 0, PF ≥1,2, dan **dua arah teruji** (LONG & SHORT masing-masing ≥30). Backtest **bukan** bukti.
- **Perbandingan** forward vs backtest vs "jendela & koin bersama" (backtest tiap mesin memakai jendela waktu berbeda, jadi tidak boleh dibandingkan langsung).
- **Peringatan** otomatis: workflow mati/telat, fill rate rendah, backtest bergantung pada 1–2 koin, bias SHORT, drawdown vs risiko, backtest identik antar mesin, sinyal kembar antar mesin, `config_hash` berganti, koin tokenisasi saham/mirip-stablecoin di universe scanner, dll.
- **Corong sinyal**, **sinyal menunggu** (harga live; ditandai BASI bila harga sudah melewati TP1), **kurva ekuitas**.
- **Bedah mesin**: per arah, trigger/TF, koin, sesi, skor, lebar stop, hari, rezim volatilitas BTC, arah BTC; durasi; level unik (N efektif); konsentrasi; sensitivitas biaya & biaya impas.
- **Jurnal forward** (cari/filter). Kolom **Tercapai (UTC)** dan **Tercapai (WIB)** = tanggal & jam trade selesai (TP2 / stop / TP1 lalu BE / timeout) menurut jurnal mesin, beresolusi candle 15m.
- **Laporan untuk Claude**: maks 4 kolom (3 laporan harian per tanggal WIB + 1 LIVE). Tombol **Simpan tanggal lapor** mencatat kapan laporan sudah dikirim ke Claude di Firebase (realtime; cadangan localStorage bila Firebase gagal). Biru = belum dilaporkan sampai hari terakhir tampil; hijau = sudah.

## Metodologi (singkat dan jujur)
- R versi monitor = R bersih mesin dibalik ke kotor (+biaya 0,10% mesin) lalu dikurangi biaya `costPct`. `engineFeePct` di `config.json` harus sama dengan `fee_pct_roundtrip` di `risk.yaml` mesin.
- Win = R > 0. CI95 R/trade = **bootstrap per hari** (sinyal antar koin berkorelasi dengan BTC); baru dihitung bila ≥10 hari.
- Forward hanya memakai baris ber-`config_hash` terbaru (aturan mesin: ganti hash = forward test mulai ulang).
- Backtest memakai daftar koin statis dan sinyal per-jam yang saling tumpang-tindih → lihat "level unik / N efektif". Hasil backtest yang bertumpu pada 1–2 koin atau satu arah (SHORT) = peringatan.
- Memilih "mesin terbaik" dari 3 kandidat = perbandingan ganda. Tetapkan gerbang **sebelum** melihat hasil.
- Semua ambang di `config.json` adalah hipotesis, bukan kebenaran.

## Uji
```
node --test "test/*.test.mjs"                       # uji unit (tanpa internet)
python3 test/parity.py <simulator.py mesin>          # simulator JS = simulator Python mesin (400 skenario acak)
node test/offline.mjs <folder hasil unzip mesin>     # build ujung-ke-ujung dengan Binance palsu
LOCAL_DIR=<folder> node scripts/build.mjs            # build lokal dari folder <mesin>/<mesin>-main/ (tanpa lapisan live)
```
Catatan: lapisan live (harga, rezim, uji silang, cek universe) butuh akses ke Binance dari runner Actions. Bila diblok (HTTP 451), bagian itu ditandai di Peringatan dan build tetap jalan.

## Laporan harian & Firebase
- `scripts/laporan-log.mjs` menyimpan riwayat laporan di `laporan-log.json` (dibaca ulang dari Pages tiap build). Hari yang terlewat direkonstruksi dari jurnal (diberi label REKONSTRUKSI).
- Firebase memakai proyek **msctnasgra** (Firestore `(default)`, lokasi asia-southeast1), koleksi `laporan`. Tidak perlu login. ID dokumen msctn = `YYYYMMDD0001`; field `tanggal` dan `diperbarui` (waktu server = kapan tombol **Simpan tanggal lapor** diklik). Rules di Console harus sama dengan `firestore.rules` (Firestore Database → Rules → Publish). Config ada di `index.html` (`FIREBASE_CONFIG`); catatan lama yang dulu tersimpan di proyek monitortn tidak ikut pindah, cukup klik **Simpan tanggal lapor** lagi bila perlu.

## sctnv4 (mesin Python, format `history`)
sctnv4 **tidak** menulis `signal_log.csv` / `forward_test.json` / `backtest/`; ia hanya menerbitkan `history.json` + `data.json` ke GitHub Pages-nya. Monitor memakai adapter `fmt: "history"` (blok `sctnv4` di `config.json`):

| Hal | Perlakuan |
|---|---|
| Sumber | `https://triasnugra.github.io/sctnv4/history.json` & `data.json` (Pages, publik); `config.yaml` dari raw (butuh `MONITOR_TOKEN` bila repo privat) |
| Biaya | `engineFeePct: 0.16` (= 2 × (fee 5 + slippage 3 bps) di `config.yaml` sctnv4). Monitor tetap memakai `costPct` yang sama untuk semua mesin, jadi sebanding |
| Hasil | `SL`→LOSS, `TP1_BE`, `TP2`, `TIME/TP1_TIME`→TIMEOUT. Time stop 6 jam sejak sinyal |
| Skor | skala 0-100 (ambang 75) dibagi 10 agar masuk bucket skor yang sama dengan mesin lain |
| Backtest | tidak ada di Pages (hanya artifact Actions manual) → kolom backtest sctnv4 kosong, memang begitu |
| **Arsip** | `history.json` mesin dipangkas ke 300 sinyal dan bisa ter-reset bila unduhan Pages gagal saat deploy mesin. Monitor menyimpan semua sinyal yang pernah terlihat di `arsip-sctnv4.json` (dibaca lagi dari Pages tiap build) agar gerbang 150 trade / 20 minggu tetap bisa tercapai. Bila arsip ada tetapi tak terbaca (bukan 404), build berhenti supaya arsip tidak tertimpa |
| Hash konfigurasi | history.json tidak mencatat `config_hash`. Isi `"pinHash"` di `config.json` dengan hash yang tampil di Peringatan; bila `config.yaml` berubah, muncul peringatan MERAH (forward test harus mulai ulang) |
| **Pengisian entry** | Simulator sctnv4 menganggap entry **terisi saat sinyal** dan history.json tidak menandai limit vs entry-zone. Uji silang candle 1 menit memeriksa apakah harga benar-benar menyentuh entry (kolom "sadar-pengisian"). Selisih besar = R sctnv4 terlalu optimis |
| Mode demo | run demo sctnv4 tidak dimasukkan ke arsip (dan tanggalnya sebelum `start`) |

Bila ingin memulai forward test sctnv4 ulang (mis. setelah mengubah `config.yaml`): naikkan `start` dan `pinHash` pada blok `sctnv4`.

### Uji tambahan
```
node --test "test/*.test.mjs"                          # termasuk test/sctnv4.test.mjs
python3 test/parity_v4.py <folder sctnv4-main>         # simulatePy (JS) = simulate_trade (Python sctnv4), 400 skenario acak
node test/offline_v4.mjs                               # build ujung-ke-ujung sctnv4 dengan history & Binance palsu
```
