# លេងហ្គេមឥតគិតថ្លៃក្នុង Google Colab · Free games in Colab

ស្គ្រីបមួយបន្ទាត់សម្រាប់បើក **ហ្គេម open-source** នៅលើ Colab រួចបង្ហាញ **link ចុចលេងក្នុង browser**
(រួមទាំងសំឡេង)។ គ្មានហ្គេមពាណិជ្ជកម្ម និងគ្មានឯកសារបំពានកម្មសិទ្ធិទេ — ទាំងអស់ជា free/open-source។

## ប្រើ

```python
# Colab cell 1 — ជ្រើសហ្គេម (stk | 0ad | openra | xonotic)
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/colab-game/colab-game.sh -o /tmp/colab-game.sh
!GAME=stk sh /tmp/colab-game.sh
```

ពេលរួចរាល់ វាបោះពុម្ពប្លុកមួយ៖

```
លេង    : https://xxxx.trycloudflare.com/index.html
អេក្រង់ : https://xxxx.trycloudflare.com/vnc.html?autoconnect=1...
សំឡេង  : https://yyyy.trycloudflare.com/audio.mp3
```

- **លេង** — ទំព័រតែមួយ មានអេក្រង់ហ្គេម + កម្មវិធីចាក់សំឡេង។ ចុច ▶ ដើម្បីបើកសំឡេង
- **អេក្រង់** — noVNC ដោយផ្ទាល់ (ពេញអេក្រង់)
- **សំឡេង** — MP3 stream បើកដោយឡែកបាន

## ហ្គេមដែលគាំទ្រ

| GAME | ហ្គេម | ប្រភព | ទំហំ |
|---|---|---|---|
| `stk` (default) | SuperTuxKart — ប្រណាំងឡាន | apt, ឬ tarball 1.5 ពី GitHub | ~៦០០ MB |
| `0ad` | 0 A.D. — យុទ្ធសាស្ត្រ | apt | ~១ GB |
| `openra` | OpenRA (Red Alert) | GitHub AppImage | ~១៥០ MB |
| `xonotic` | Xonotic — FPS | xonotic.org | ~១ GB |

## ប្រើលើ Kaggle ដែរបាន

Kaggle notebook មាន root និង apt ដូច Colab ដែរ។ នៅទីនេះ **ទាញយកជាឯកសារសិន រួចរត់** (មិនប្រើ `| sh`) ព្រោះ program ណាដែលអាន stdin អាចស៊ីបន្ទាត់ក្នុងស្គ្រីបបាន៖

```python
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/colab-game/colab-game.sh | GAME=stk sh
```

ស្គ្រីបរកឃើញ `/kaggle/working` ដោយស្វ័យប្រវត្តិ ហើយដាក់ឯកសារនៅទីនោះ។ Session របស់
Kaggle (អតិបរមា ~១២ ម៉ោង) រត់រហូតដល់អ្នកបិទ notebook។

## ជម្រើសបន្ថែម

```sh
WIDTH=1280 HEIGHT=720     # ទំហំអេក្រង់ (default 1280x720)
PORT=6080 AUDIO_PORT=6081 # port ក្នុងម៉ាស៊ីន
GL=hw                     # សាកប្រើ GPU (ធម្មតាប្រើ CPU/llvmpipe)
SKIP_INSTALL=1            # រំលង apt (បណ្ណាល័យមានរួច)
STOP=1                    # បញ្ឈប់ Xvfb/noVNC/ffmpeg/tunnel ទាំងអស់
```

## ធ្វើដូចម្តេច

1. `apt` — `xvfb x11vnc novnc websockify openbox pulseaudio ffmpeg`
2. ទាញយក/តំឡើងហ្គេម (បើ apt គ្មាន → tarball/AppImage/zip ផ្លូវការ)
3. PulseAudio null sink `colabgame` → `ffmpeg -listen 1` បម្រើ MP3
4. `Xvfb :1` + `openbox` + `x11vnc` + `websockify --web`
5. tunnel ពីរ (Cloudflare quick tunnel) — អេក្រង់ និង សំឡេង
6. បើកហ្គេមលើ `DISPLAY=:1` រួចបោះពុម្ព link

## ដែនកំណត់

- Rendering ជា **CPU (llvmpipe)** ព្រោះ GPU នៅលើ Colab គ្មានអេក្រង់ — FPS មធ្យម
  (STK ~២០–៣០ FPS នៅ 1280x720)។ `GL=hw` សាកប្រើ GPU តែអាស្រ័យលើ driver។
- សំឡេងយឺតជាងអេក្រង់ ~១–៣ វិនាទី (ទឹកហូរ MP3 ឆ្លង tunnel)។
- `trycloudflare.com` URL ស្លាប់ភ្លាមពេល Colab session ដាច់ — រត់ស្គ្រីបម្តងទៀតបាន link ថ្មី។
- ស្គ្រីបប្រើ `pkill` តែលើ process របស់វាផ្ទាល់ (port/sink ដែលវាបង្កើត)។
