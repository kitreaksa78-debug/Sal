# audio-separator stem service (ញែកភ្លេងដោយម៉ូឌែល)

Mini service ដែលរុំ package **`audio-separator`** (UVR / MDX-Net / Demucs — ដូចដែល
**TachiDUBB Studio** ប្រើ) ហើយបើកជា HTTP API សម្រាប់ backend របស់គេហទំព័រ។

**ហេតុអ្វីត្រូវការវា?** Backend (Node/FFmpeg លើ Render) រត់ម៉ូឌែល UVR ដោយខ្លួនឯងមិនបានទេ
(គ្មាន Python គ្មាន GPU)។ ដូច្នេះការញែកភ្លេងរត់នៅទីនេះ រួច pipeline ខ្មែរទាញ stems តាម HTTP។

| Stem | ខ្លឹមសារ | ប្រើធ្វើអ្វី |
|---|---|---|
| `vocals.wav` | សំឡេងនិយាយ (គ្មានភ្លេង) | STT + កំណត់អ្នកនិយាយ ច្បាស់ជាងមុន |
| `instrumental.wav` | ភ្លេង + សំឡេងផ្ទៃខាងក្រោយ (គ្មានសំឡេងនិយាយ) | ភ្លេងដើមនៅរស់ — លែងដាច់ពេលអ្នកនិយាយ |

> ព្រោះសំឡេងនិយាយត្រូវបានដកចេញពី background ទាំងស្រុង កម្មវិធីលាយសំឡេងលែងបន្ថយភ្លេង −30 dB
> ទៀតទេ — វានៅតែ **−6 dB** ពេលខ្មែរនិយាយ (ដូច HeyGen)។

## ដំណើរការ ១០ នាទី

### Docker (ស្រួលបំផុត — GPU ឬ CPU)

```bash
cd tools/audio-separator-server
docker build -t audio-separator-service .
docker run -d --name stems -p 8920:8920 \
  -e SEPARATOR_API_KEY=change-me \
  -v as-models:/models -v as-data:/data \
  audio-separator-service
# GPU: បន្ថែម --gpus all ហើយប្តូរ requirements.txt ទៅ audio-separator[gpu]
```

### ដោយផ្ទាល់ (Python 3.10–3.12)

```bash
cd tools/audio-separator-server
python -m venv venv && . venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8920
```

បើកដំបូង វានឹងទាញម៉ូឌែល (~៧០ MB សម្រាប់ MDX) ម្តងគត់។ CPU ក៏ដើរបាន តែយឺតជាង ~៣–៨ ដង។

## ភ្ជាប់ទៅគេហទំព័រ

ដាក់ variable ទាំងនេះក្នុង **Render → Environment** (ឬ `.env` ពេល test ក្នុងម៉ាស៊ីន):

| Key | តម្លៃ | ចាំបាច់ |
|---|---|---|
| `AUDIO_SEPARATION_PROVIDER` | `audio_separator` | ✅ |
| `AUDIO_SEPARATOR_URL` | `http://<host>:8920` (ត្រូវបើកចេញក្រៅ បើ Render នៅឆ្ងាយ) | ✅ |
| `AUDIO_SEPARATOR_API_KEY` | ដូច `SEPARATOR_API_KEY` ខាងលើ | ណែនាំ |
| `AUDIO_SEPARATOR_MODEL` | ឈ្មោះម៉ូឌែល (default `UVR-MDX-NET-Inst_HQ_3`) | មិនចាំបាច់ |
| `AUDIO_SEPARATOR_TIMEOUT_MS` | default `1800000` (៣០ នាទី) | មិនចាំបាច់ |

> 🌐 **បើ service រត់ក្នុងម៉ាស៊ីនផ្ទះ/VPS** កុំបើក port ទទេៗចេញអ៊ីនធឺណិត — ប្រើ
> **Cloudflare Tunnel** (`cloudflared tunnel --url http://localhost:8920`) ឬ Tailscale រួចដាក់ URL
> នោះក្នុង `AUDIO_SEPARATOR_URL`។ កុំភ្លេចដាក់ `SEPARATOR_API_KEY`។

### ពិនិត្យថាដំណើរការ

```bash
curl http://localhost:8920/health
# {"status":"ok","model":"UVR-MDX-NET-Inst_HQ_3.onnx","busy":false}

curl https://aivideotranslate.dev/api/config/status | grep -A3 audioSeparation
# provider គួរបង្ហាញ "audio_separator" និង configured: true
```

## សុវត្ថិភាព និងការដួលរលំ

* គ្មាន key → គ្មាន auth។ ដាក់ `SEPARATOR_API_KEY` ជានិច្ចបើបើកចេញក្រៅ។
* Stem ចាស់ត្រូវលុបស្វ័យប្រវត្តិក្រោយ `SEPARATOR_TTL_HOURS` (default ១២ ម៉ោង)។
* Upload ធំជាង `SEPARATOR_MAX_MB` (default ២០៤៨ MB) → ឆ្លើយ 413។
* បើ service ដួល ឬ timeout → គេហទំព័រ**មិនខូច**ទេ៖ provider ថយទៅវិធី FFmpeg DSP ដើមវិញ
  ហើយការងារបន្តធម្មតា (មានសារព្រមានជាភាសាខ្មែរក្នុងលទ្ធផល)។

## អាជ្ញាបណ្ណ

`audio-separator` (beveradb) ជា MIT ដូច TachiDUBB។ ម៉ូឌែល UVR/MDX មានអាជ្ញាបណ្ណរៀងៗខ្លួន —
ពិនិត្យមុនប្រើពាណិជ្ជកម្ម។
