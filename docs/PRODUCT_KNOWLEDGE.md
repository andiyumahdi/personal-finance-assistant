# Nera — Product Knowledge Base & FAQ (Sprint C revision, LOCKED)

**Status: LOCKED as of this revision.** This is the single source of truth
`product_question` responses will be grounded in — nothing outside this
list should be claimed as a capability. Every "Bisa" item is cross-checked
against actual implemented code. "Belum tersedia saat ini" vs
"direncanakan di roadmap" is cross-checked against the actual locked
Sprint C/D/E scope in `docs/ROADMAP.md`, not guessed.

---

## 1. Prinsip Nera

- Nera itu asisten yang diajak ngobrol, bukan aplikasi pencatat manual — nggak perlu buka app, tinggal chat.
- Nggak ada command khusus (misal "/catat"). Bahasa sehari-hari aja cukup.
- Kalau informasi dari user kurang jelas (misal arah uang ambigu), Nera akan nanya dulu, bukan nebak.
- Nera nggak akan ngarang data atau fitur yang belum ada — kalau belum bisa, akan bilang jujur belum bisa.

## 2. Cara Menggunakan Nera

- **Catat transaksi:** langsung chat aja, contoh "jajan 20rb" atau "gaji bulan ini 5jt". Nggak perlu format khusus.
- **Minta rekap:** ketik "rekap" atau "habis berapa minggu ini". Rekap juga otomatis dikirim tiap Senin (mingguan) dan tanggal 1 (bulanan) kalau ada transaksi di periode itu.
- **Bikin goal:** ketik sesuatu kayak "mau nabung buat laptop", nanti Nera nanya target nominal dan tanggalnya.
- **Ubah/hapus transaksi:** tinggal bilang, misal "yang 20rb tadi jadi 25rb" (ubah) atau "hapus yang 20rb" — Nera minta konfirmasi dulu sebelum beneran dihapus. Salah hapus? Ketik "undo" buat balikin transaksi terakhir.
- **Cari riwayat transaksi:** ketik "cari transaksi makan" atau "cari pengeluaran 20rb", hasilnya maksimal 5 transaksi.
- **Kelola dompet:** ketik "tambah dompet BRI", "ganti nama dompet BRI jadi BRI Syariah", "arsipkan dompet Mandiri", atau "hapus dompet OVO" — bisa juga lewat dashboard **Settings → Wallets** (detail di bagian **11. Dompet**).
- **Buka dashboard:** ketik "dashboard" atau "login" ke chat ini, nanti dikirimin link buat connect.
- **Login (pertama kali):** klik link yang dikirim bot, lanjut login pakai akun Google. Setelah itu, login berikutnya tinggal pakai Google seperti biasa.

## 3. Transaksi (Recording)

**Bisa:**
- Catat transaksi lewat chat natural, tanpa format khusus
- Deteksi otomatis: expense vs income, kategori, nominal
- Transaksi kedua yang dikirim tak lama setelah yang pertama, otomatis kecatat sebagai transaksi terpisah (bukan gabung/nimpa)
- Koreksi transaksi terakhir kalau salah ketik ("eh salah, yang tadi 15rb"), selama masih dalam window waktu singkat setelah transaksi itu
- Kalau arah uang (masuk/keluar) ambigu, Nera nanya balik dulu
- Kalau nominal nggak disebutkan (misal "bayar netflix" tanpa angka), Nera nanya nominalnya
- Edit transaksi lewat chat, misal "yang 20rb tadi jadi 25rb" atau "ubah kategorinya jadi makanan" — Nera nanya dulu kalau transaksinya yang dimaksud nggak jelas
- Hapus transaksi lewat chat, misal "hapus yang 20rb" — selalu minta konfirmasi "ya"/"batal" dulu, nggak pernah langsung hapus
- Cari riwayat transaksi lewat chat, misal "cari transaksi makan" atau "cari pengeluaran 20rb" — hasil maksimal 5 transaksi
- Undo transaksi terakhir yang dihapus ("undo" atau "balikin transaksi tadi") — cuma transaksi yang barusan dihapus aja yang bisa dibalikin
- Kelola kategori lewat chat ("buat kategori …", "ganti nama kategori … jadi …", "hapus kategori …") — detail lengkap di bagian **4. Kategori**
- Kelola dompet/sumber dana lewat chat ("tambah dompet …", "ganti nama dompet … jadi …", "arsipkan/aktifkan dompet …", "hapus dompet …") — detail lengkap di bagian **11. Dompet**

**Belum tersedia saat ini:**
- Satu pesan berisi lebih dari satu transaksi sekaligus (misal "beli baju sama sepatu 200rb" belum otomatis kepisah)

## 4. Kategori

**Bisa:**
- Nera otomatis memilih kategori dari daftar aktif kamu: 10 kategori bawaan (Makanan & Minuman, Transport, Belanja, Tagihan, Hiburan, dll) plus kategori buatanmu sendiri
- Bikin kategori sendiri lewat chat, misal "buat kategori Kopi Langganan"
- Ganti nama kategori lewat chat ("ganti nama kategori Kopi jadi Kopi Pagi") atau di dashboard **Settings → Categories** — transaksi aktif kamu ikut keganti otomatis
- Hapus kategori sendiri lewat chat ("hapus kategori Kopi") atau di Settings → Categories
- Pantau daftar kategori + jumlah transaksi aktif per kategori di Settings → Categories; filter kategori di halaman Transaksi ikut daftar terbaru

**Aturan:**
- Kategori bawaan nggak bisa diganti namanya atau dihapus (di Settings tampil terkunci)
- Kategori yang masih dipakai transaksi aktif nggak bisa dihapus — Nera kasih tahu jumlahnya; transaksi yang sudah dihapus (soft-delete) tetap menyimpan label lamanya
- Maksimal 50 kategori sendiri per user; nama harus unik per user (gak bisa duplikat, termasuk nama bawaan)
- Chat dan Settings selalu pakai daftar kategori yang sama

**Belum tersedia saat ini:**
- Tombol "Add Category" di Settings — bikin kategori baru masih lewat chat dulu

## 5. Rekap

**Bisa:**
- Minta rekap kapan aja lewat chat
- Rekap otomatis mingguan (Senin) dan bulanan (tanggal 1) — dikirim cuma kalau ada transaksi di periode itu
- Isinya total pemasukan, pengeluaran, dan saldo (net) periode itu

**Belum tersedia saat ini:**
- Rekap custom per rentang tanggal tertentu
- Rekap per kategori spesifik lewat chat

## 6. Goals (Target Nabung)

**Bisa:**
- Bikin goal baru lewat chat
- Progress goal (persentase, sisa target) otomatis update tiap ada kontribusi
- Goal otomatis jadi "tercapai" begitu target ketemu
- Lihat, edit, dan tambah kontribusi ke goal lewat dashboard

**Belum tersedia saat ini:**
- Edit atau tambah kontribusi ke goal lewat chat (baru bisa lewat dashboard)
- Hapus goal

## 7. Dashboard

Dashboard membantu kamu melihat kondisi keuangan secara lebih lengkap
dibanding yang bisa ditampilkan lewat chat, seperti grafik, riwayat
transaksi, analisis, dan progress target.

**Bisa:**
- Lihat ringkasan keuangan bulan ini dan progress dibanding bulan lalu
- Lihat tren keuangan beberapa bulan terakhir dalam bentuk grafik
- Cari dan filter semua transaksi yang pernah tercatat
- Lihat ke mana aja uang paling banyak kepakai
- Kelola goals (bikin, edit, tambah kontribusi)
- Atur tampilan (mode terang/gelap)
- Kelola dompet/sumber dana (buat, ganti nama, arsip/aktifkan, hapus) di **Settings → Wallets**; saldo tiap dompet kelihatan langsung di situ; halaman Transaksi punya kolom **Dompet** (detail di bagian **11. Dompet**)

**Belum tersedia saat ini:**
- Tambah/edit transaksi manual dari dashboard (transaksi cuma bisa lewat WhatsApp, itu memang prinsip desainnya — lihat bagian 9)
- Export data
- Filter berdasarkan dompet di halaman Transaksi (kolomnya ada, filternya belum)

## 8. Login & Keamanan Data

**Bisa:**
- Login pakai akun Google
- Login pertama kali lewat link khusus dari bot WhatsApp — ini yang menyambungkan akun Google ke nomor WhatsApp kamu
- Login berikutnya tinggal pakai Google seperti biasa, nggak perlu link lagi
- Nomor WhatsApp adalah identitas utama di Nera, bukan email

**Belum tersedia saat ini:**
- Ganti nomor WhatsApp yang sudah tersambung
- Satu akun Google tersambung ke lebih dari satu nomor WhatsApp (sengaja dibatasi gitu, demi keamanan data)

**Sedang dipertimbangkan (belum ada jadwal pasti):**
- Login pakai email & password sebagai alternatif Google

## 9. Kenapa desainnya begini

Kalau user nanya alasan di luar poin-poin ini, jawab jujur nggak tau — jangan improvisasi.

- **Kenapa login harus lewat WhatsApp dulu, bukan langsung Google?** Karena nomor WhatsApp itu identitas utama di Nera — dashboard cuma pelengkap. Ini juga jadi lapisan keamanan, biar nggak sembarang akun Google bisa nyambung ke data siapa pun.
- **Kenapa transaksi cuma bisa dicatat lewat WhatsApp, bukan dashboard?** Biar secepat dan senatural mungkin — tinggal chat, nggak perlu buka app dan isi form.
- **Kenapa nggak ada command khusus?** Karena Nera didesain buat dipakai dengan bahasa sehari-hari, bukan command teknis.

## 10. FAQ Operasional

- **Nera ini gratis?** Ya, gratis.
- **Data aku aman nggak?** Aman — data kamu cuma bisa diakses lewat akun kamu sendiri, nggak bisa dilihat orang lain.
- **Data aku disimpan di mana?** Disimpan online, jadi tetap ada dan bisa diakses walaupun kamu ganti perangkat — asal lewat akun yang sudah tersambung.
- **Kalau internet mati apakah masih bisa dipakai?** Nera jalan lewat WhatsApp dan dashboard online, jadi tetap butuh koneksi internet.
- **Kalau aku salah catat gimana?** Kalau baru aja, bisa dikoreksi langsung di chat ("eh salah, yang tadi 15rb"). Kalau transaksinya udah lama juga bisa — bilang "yang 20rb tadi jadi 25rb" buat ngedit, atau "hapus yang 20rb" buat hapus (Nera minta konfirmasi dulu). Salah hapus? Ketik "undo" selama belum ada transaksi lain yang dihapus sesudahnya (lihat bagian 3).
- **Kalau aku ganti HP gimana?** Nggak masalah, karena datanya nggak nyimpen di HP — tinggal lanjut chat dari nomor WhatsApp yang sama seperti biasa.
- **Kalau aku ganti akun Google gimana?** Untuk sekarang belum ada mekanisme buat ganti/sambungin ulang ke akun Google lain — nomor WhatsApp kamu tetap tersambung ke akun Google yang pertama kali dipakai.

## 11. Dompet (Sumber Dana)

**Bisa:**
- Tiap user punya satu dompet default "Dompet Utama" — transaksi yang nggak nyebut sumber dana otomatis dihitung ke sana
- Catat transaksi sambil nyebut sumber dananya, misal "bayar netflix dari BCA 200rb" — kalau namanya cocok sama dompet kamu, otomatis nempel; kalau namanya nggak dikenal atau dompetnya udah kearsip, diam-diam dihitung ke dompet default (Nera nggak pernah bikin dompet baru dari nama di pesan)
- Kelola dompet lewat chat: "tambah dompet BRI", "ganti nama dompet BRI jadi BRI Syariah", "arsipkan dompet Mandiri" / "aktifkan dompet Mandiri", "hapus dompet OVO"
- Kelola dompet di dashboard: **Settings → Wallets** (buat, ganti nama, arsip/aktifkan, hapus) — plus kolom **Dompet** di halaman Transaksi
- Saldo tiap dompet = pemasukan − pengeluaran dari transaksi aktif (dihitung langsung tiap dibuka, bukan angka tersimpan)
- Ganti nama dompet tidak pernah mengubah transaksi — riwayat selalu nunjuk nama dompet terbaru

**Aturan:**
- Nama dompet 2–40 karakter, unik per user (beda huruf besar/kecil tetap dianggap sama, termasuk nama yang udah diarsip)
- Dompet default bisa diganti namanya, tapi tidak bisa diarsip atau dihapus
- Arsip bersifat balik: dompet yang kearsip nggak muncul sebagai pilihan transaksi baru, tapi riwayat dan saldonya tetap utuh — bisa diaktifkan kapan aja
- Hapus dompet cuma boleh kalau nggak ada satu pun transaksi yang nunjuk ke sana (termasuk transaksi yang udah dihapus); kalau masih ada, Nera nolak dan kasih tahu jumlahnya
- Tiap user bebas punya banyak dompet dengan jenis tunai / bank / e-wallet; dompet yang dibuat lewat chat selalu masuk jenis tunai
- Chat dan Settings selalu pakai daftar dompet yang sama

**Belum tersedia saat ini:**
- Filter berdasarkan dompet di halaman Transaksi (kolomnya aja yang udah ada)
- Budget dan transfer antar dompet (Sprint D3 / D4)
- Saldo yang narik langsung dari rekening bank/e-wallet — semua dicatat manual lewat chat

---

**Status: LOCKED.** Approved as the source of truth for the
`product_question` prompt content — Sprint B baseline, revised after
Sprint C shipped (edit / hapus / cari / undo transaksi lewat chat, all
cross-checked against implemented code), then synced after Sprint D1
(category management) and Sprint D2 (wallet management: chat +
Settings → Wallets, section 11) shipped. Any future product change (new
feature, changed behavior) should update this file first, then the
prompt that's grounded in it — not the other way around.
