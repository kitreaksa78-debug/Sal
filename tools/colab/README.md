# Colab T4 — ញែកភ្លេង + សម្អាតសំឡេង (service តែមួយ)

Notebook មួយសម្រាប់ការងារពីរ៖

| Endpoint | ធ្វើអ្វី | ហៅដោយ |
| --- | --- | --- |
| `POST /separate` | Demucs បំបែក **vocals / instrumental** | សាយ (ផ្ទាំងទី១) |
| `POST /enhance` | UVR ដកហ៊ឹស/កង្ហារ (`denoise`), echo (`dereverb`), bleed (`debleed`) | curl / ជំហានសម្អាតជ្រៅ |
| `GET /health` | ស្ថានភាព + ឧបករណ៍ (cuda/cpu) | សាយ / អ្នក |
| `GET /files/<job>/<name>` | ឯកសារដែលបានបង្កើត | សាយ |

## វិធីលឿនបំផុត — បន្ទាត់តែមួយ (ណែនាំ)

រត់ក្នុង cell មួយក្នុង Colab (Runtime → T4 GPU)៖

```bash
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-colab/colab-start.sh | sh
```

វាតំឡើង Demucs + UVR, បើក service, បើក tunnel, រង់ចាំរហូត tunnel ឆ្លើយពិត,
រួចបោះពុម្ពប្លុកតែមួយដែលចម្លងដាក់ក្នុងសាយបានតែម្តង៖

```
URL : https://xxxx.trycloudflare.com
API Key : 3f9c…
```

រត់បន្ទាត់នេះម្តងទៀតពេល session ដាច់ — **Key ដដែល** (រក្សាក្នុង `/content/.demucs-service-key`)
ដូច្នេះក្នុងសាយប្តូរតែ URL។

បើ log បង្ហាញ `Failed to dial a quic connection` (network បិទ UDP 7844)៖

```bash
PROTOCOL=http2 sh colab-start.sh
```

## ដំណើរការ (notebook)

1. បើក [`studio_t4.ipynb`](studio_t4.ipynb) ក្នុង [Google Colab](https://colab.research.google.com/) (File → Upload notebook)
2. Runtime → Change runtime type → **T4 GPU**
3. រត់ cell ទាំងអស់ពីលើចុះក្រោម
4. cell ៦ បោះពុម្ព `URL : https://xxxx.trycloudflare.com` និង `KEY : …`
5. ចូលសាយ → កាត **«ញែកភ្លេង · Demucs API»** → paste URL (បើដាក់ `SERVICE_KEY` ត្រូវ paste key ដែរ) → **រក្សាទុក**
6. Upload វីដេអូ/បទ → ទាញ `vocals-*.mp3` (សំឡេងច្រៀងសុទ្ធ)

## សម្អាត vocal stem បន្ថែម (UVR)

```bash
curl -sS -H "Authorization: Bearer $SERVICE_KEY" \
  -F "audio=@vocals.wav" -F "task=denoise" \
  https://xxxx.trycloudflare.com/enhance
```

| `task` | ម៉ូឌែលលំនាំដើម | កែអ្វី |
| --- | --- | --- |
| `denoise` | `UVR-DeNoise.pth` | ហ៊ឹស · កង្ហារ · ខ្យល់ · សំឡេងបរិស្ថាន |
| `dereverb` | `UVR-DeEcho-DeReverb.pth` | echo · សំឡេងរង្គោះរង្គើ |
| `debleed` | `mel_band_roformer_denoise_debleed_gabox.ckpt` | ភ្លេងលូកចូល vocal |

ឈ្មោះម៉ូឌែលប្តូរតាមកំណែ — ពិនិត្យជាមួយ `audio-separator --list_models`
ឬដាក់ឈ្មោះផ្ទាល់ក្នុង field `model`។

## កែសម្រួល service

`service.py` ជាប្រភពតែមួយ; notebook ត្រូវបង្កើតឡើងវិញពីវា៖

```bash
python3 tools/colab/make-notebook.py
```

(មាន cell `%%writefile` ដែលដាក់កូដដូចគ្នាទៅ `/content/service.py` ក្នុង Colab។)

## សុវត្ថិភាព និងដែនកំណត់

- ដាក់ `SERVICE_KEY` ជានិច្ច — tunnel ជាសាធារណៈ; អ្នកណាមាន URL នឹងប្រើ GPU របស់អ្នកបាន។
- Colab ឥតគិតថ្លៃ ~១២ ម៉ោង/សប្តាហ៍, session ដាច់ពេលអសកម្ម → URL ថ្មី, paste ម្តងទៀតក្នុងសាយ។
- Stem រក្សាក្នុង `/content/stems/<job>/` រហូត session ដាច់ (គ្មាន TTL)។
- Demucs ត្រូវការ VRAM ~៣–៤ GB សម្រាប់បទធម្មតា; T4 គ្រប់គ្រាន់។
