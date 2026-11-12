<div align="center">

# losslesscut-mcp

**Claude ve diğer yapay zekâ asistanları videolarını görsün ve [LosslessCut](https://github.com/mifi/lossless-cut) ile kessin.**

Medyana FFmpeg ile bakan (kareler, sahneler, sessizlik, ses seviyesi, keyframe'ler) ve LosslessCut'u yerel HTTP API'siyle yöneten bir [MCP](https://modelcontextprotocol.io) sunucusu.
*"Renk çubuklarını ve son 3 saniyeyi tut, dışa aktar"* dersin, dosyalar kayıpsız kesilmiş olarak hazır olur.

[English](README.md) · Türkçe

</div>

![Demo: asistan bir videoyu açar, kare özetine bakar, sahne geçişlerini bulur, LosslessCut'a iki segment yükler ve dışa aktarır](docs/demo.gif)

*LosslessCut 3.70.2 ile gerçek çalışma: her adım bir MCP araç çağrısı, görüntüler LosslessCut penceresi.*

## Neler yapabiliyor

### Medyayı görme ve analiz

Bunlar FFmpeg ile yerelde çalışır; LosslessCut açık olsun ya da olmasın her dosyada kullanılabilir. LosslessCut'un kendisinin gösterebildiği ya da tespit edebildiği şeylerin karşılığıdır.

| Araç | Ne yapar |
| --- | --- |
| `media_info` | Süre, kapsayıcı, akışlar (codec, çözünürlük, fps, ses kanalları, dil) ve bölümler |
| `contact_sheet` | Videonun tamamını ya da bir kısmını taramak için kare ızgarası tek bir görselde |
| `view_frames` | Belirli zamanlardaki ya da eşit aralıklı kareler, asistanın görebileceği görüntüler olarak |
| `detect_scenes` | Sahne değişimleri ve sert geçişler |
| `detect_silence` | Sessiz kısımlar ve aradaki sesli kısımlar |
| `detect_black` | Kararmalar, aralar gibi siyah kısımlar |
| `audio_levels` | Zamana göre ses yüksekliği (EBU R128) ve en yüksek anlar |
| `keyframes` | Keyframe'ler ve verilen zamanların çevresindekiler; kayıpsız kesimin nereye düşeceğini gösterir |
| `check_tools` | Hangi FFmpeg ve FFprobe'un kullanıldığını gösterir |

### LosslessCut'u yönetme

| Araç | Ne yapar |
| --- | --- |
| `check_connection` | LosslessCut'un HTTP API ile `127.0.0.1` üzerinde çalıştığını kontrol eder |
| `open_files` | Medya ya da `.llc` proje dosyalarını açar (yalnızca tam yol, varlığı kontrol edilir) |
| `set_segments` | Tam bir segment listesini (isimleriyle) tek adımda, LosslessCut'un kendi proje dosyasıyla yükler |
| `add_segment` / `set_cut_points` | Segment ekler ya da geçerli segmentin başını/sonunu taşır |
| `seek` | Oynatma başlığını taşır (`75.5`, `01:15.5`, `00:01:15.500`) |
| `select_segments` / `jump_to_segment` | Seçim ve gezinme |
| `export_file` | Seçili segmentleri dışa aktarır, dışa aktarma penceresini onaylar, çıktı yollarını döndürür |
| `wait_for_export` | Süren dışa aktarmayı bekler ve çıktı yollarını döndürür |
| `close_file` | Geçerli dosyayı kapatır |
| `list_actions` / `run_action` | İzin listesindeki 135 LosslessCut klavye eylemi, örneğin `splitCurrentSegment` ya da `toggleStripAudio` |

Kesimin kendisini LosslessCut ve FFmpeg yeniden kodlamadan yapar, tıpkı düğmelere sen basmışsın gibi.

## Gereksinimler

- [LosslessCut](https://github.com/mifi/lossless-cut/releases) 3.70 ya da üstü (Windows 11'de 3.70.2 ile test edildi)
- [Node.js](https://nodejs.org) 20 ya da üstü
- Analiz araçları için `PATH` üzerinde FFmpeg ve FFprobe (ya da `LOSSLESSCUT_MCP_FFMPEG` / `LOSSLESSCUT_MCP_FFPROBE` ayarla; LosslessCut ikisini de `resources` klasöründe getirir)
- Bir MCP istemcisi: Claude Desktop, Claude Code ya da stdio sunucularını destekleyen başka bir istemci

## 1. LosslessCut'u HTTP API ile başlat

API varsayılan olarak kapalıdır. LosslessCut'u terminalden `--http-api` ile başlat:

```bash
# Windows
"C:\path\to\LosslessCut.exe" --http-api

# macOS
/Applications/LosslessCut.app/Contents/MacOS/LosslessCut --http-api

# Linux
./LosslessCut --http-api
```

`127.0.0.1:8080` adresini dinler. Başka bir port için `--http-api 8081` ver ve bu sunucu için de `LOSSLESSCUT_PORT=8081` ayarla.
LosslessCut'un [HTTP API belgelerine](https://github.com/mifi/lossless-cut/blob/master/docs/api.md) bakabilirsin.

## 2. Sunucuyu istemcine ekle

### Claude Code

```bash
claude mcp add losslesscut -- npx -y github:bariswha/losslesscut-mcp
```

### Claude Desktop

**Settings → Developer → Edit Config** ile `claude_desktop_config.json` dosyasını aç, şunu ekle ve Claude Desktop'ı yeniden başlat:

```json
{
  "mcpServers": {
    "losslesscut": {
      "command": "npx",
      "args": ["-y", "github:bariswha/losslesscut-mcp"],
      "env": { "LOSSLESSCUT_PORT": "8080" }
    }
  }
}
```

### Diğer MCP istemcileri

stdio sunucusu başlatabilen her istemci çalışır. Komut olarak `npx -y github:bariswha/losslesscut-mcp` kullan ya da bir klondan çalıştır:

```bash
git clone https://github.com/bariswha/losslesscut-mcp.git
cd losslesscut-mcp
npm ci
node src/index.js --port 8080
```

## 3. İste

- "`D:\Videolar\sunum.mp4` dosyasını LosslessCut'ta aç."
- "Bu videoya göz at ve sahnelerin nerede değiştiğini söyle."
- "Bir saniyeden uzun sessiz araları çıkar, kalanı tek dosya olarak dışa aktar."
- "En yüksek sesli anları bul, her birinin çevresinde 20 saniyelik segment yap ve dışa aktar."
- "0:02–0:05 ve 0:07–0:09.5 arasını tut, adlarını giriş ve demo koy, dışa aktar."

Asistana tam dosya yolunu ver. Yol tahmin etmemesi söylenir; tüm araçlar göreli yolları ve var olmayan dosyaları reddeder.

## Yapılandırma

| Ayar | Varsayılan | |
| --- | --- | --- |
| `--port <n>` ya da `LOSSLESSCUT_PORT` | `8080` | LosslessCut HTTP API portu |
| `--no-frames` ya da `LOSSLESSCUT_MCP_FRAMES=off` | açık | `view_frames` ve `contact_sheet` araçlarını kapatır; asistan videolarının hiçbir görüntüsünü almaz |
| `--disable-tools a,b` ya da `LOSSLESSCUT_MCP_DISABLE_TOOLS` | yok | Herhangi bir aracı adıyla kapatır |
| `LOSSLESSCUT_MCP_FFMPEG` / `LOSSLESSCUT_MCP_FFPROBE` | `ffmpeg` / `ffprobe` | FFmpeg programlarının yolları |

Örneğin Claude Code'da kare görme kapalı:

```bash
claude mcp add losslesscut -e LOSSLESSCUT_MCP_FRAMES=off -- npx -y github:bariswha/losslesscut-mcp
```

Çoğu istemci tek tek araçları kendi ayarlarından da açıp kapatabilir: örneğin Claude Desktop'taki araçlar menüsü, Claude Code'da `/mcp` ve izin kuralları.

## Güvenlik

- Yalnızca `127.0.0.1` üzerindeki LosslessCut ile konuşur. Başka ağ erişimi ve telemetri yok. Analiz FFmpeg ile yerelde yapılır.
- Hiçbir zaman `Origin` başlığı göndermez; LosslessCut'un tarayıcı koruması diğer her şey için geçerli kalır.
- FFmpeg ve FFprobe kabuk (shell) üzerinden değil, doğrudan argüman listesiyle başlatılır.
- `run_action` yalnızca sabit bir izin listesindeki eylemleri çalıştırır. `quit`, `cleanupFilesDialog` (kaynak dosyaları çöpe taşıyabilir), `openSendReportDialog` ve URL indirme eylemi engellidir.
- Tüm girdiler doğrulanır: zamanlar ayrıştırılıp aralık kontrolünden geçer, yollar tam yol olmalı, var olan dosyayı göstermeli ve kontrol karakteri içermemelidir.
- `set_segments`, LosslessCut'un proje dosyasını medyanın yanına (`<ad>-proj.llc`) yazar; var olan dosyayı önce `.bak` yedeği olarak yeniden adlandırır. İstediğin dışa aktarmalar dışında başka hiçbir şey yazılmaz.
- LosslessCut'un HTTP API'sinde kimlik doğrulama yoktur: `--http-api` ile çalışırken bilgisayarındaki her program onu kontrol edebilir. Yalnızca kullanırken aç.

Ayrıntılar [SECURITY.md](SECURITY.md) dosyasında.

## Sınırlamalar

Bunlar LosslessCut'un deneysel HTTP API'sinden gelir:

- **Okuma erişimi yok.** API açık dosyayı, segmentleri ya da oynatma başlığını bildiremez; asistan ne yaptığını kendisi takip eder. Analiz araçları uygulamayı değil, dosyanın kendisini okur.
- **Hata bildirimi yok.** LosslessCut içinde başarısız olan bir eylem HTTP'de yine başarılı döner.
- **Pencereler.** LosslessCut bir pencere açarsa (örneğin zaten bir dosya açıkken) eylem seni bekler; sunucu bunu 30 saniye sonra bildirir. `list_actions` içindeki `dialog` grubundaki eylemler her zaman bir pencere açar.
- **Zaman kodu biçimi.** `seek`, `hh:mm:ss.fff` gönderir; LosslessCut bunu varsayılan biçimiyle okur. Biçimi kare ya da saniyeye çevirdiysen `set_segments` kullan.
- **Kayıpsız kesimler keyframe'e oturur** (LosslessCut'ta akıllı kesim açık değilse), bu yüzden çıktı istenenden biraz önce başlayabilir. `keyframes` nereye oturacağını gösterir.

## Geliştirme

```bash
npm ci
npm test
```

Testler sahte bir LosslessCut HTTP sunucusuna karşı çalışır; FFmpeg kuruluysa analiz testleri üretilmiş bir video üzerinde gerçek FFmpeg çalıştırır.

## Bağlantısızlık

losslesscut-mcp bağımsız bir projedir. LosslessCut ya da yazarıyla bağlantılı değildir, onlar tarafından desteklenmez ya da sürdürülmez.
LosslessCut © Mikael Finstad, GPL-2.0 lisanslıdır.

## Lisans

[MIT](LICENSE). Bu sunucu LosslessCut ile HTTP üzerinden konuşan ve FFmpeg'i ayrı bir süreç olarak çalıştıran ayrı bir programdır. LosslessCut ya da FFmpeg kodu içermez; bu yüzden onların lisansları ona uzanmaz ve onu kullanmak onları nasıl kullanabileceğini değiştirmez.
