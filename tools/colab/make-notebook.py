"""Build studio_t4.ipynb from service.py, so the two can never drift apart.

    python3 tools/colab/make-notebook.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).parent
source = (ROOT / "service.py").read_text(encoding="utf-8")


def code(text):
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": text.splitlines(keepends=True),
    }


def markdown(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.splitlines(keepends=True)}


cells = [
    markdown(
        "# ស្ទូឌីយោ Colab T4 — ញែកភ្លេង + សម្អាតសំឡេង\n"
        "\n"
        "Notebook នេះបើក service មួយដែលធ្វើការងារពីរ៖\n"
        "\n"
        "1. **ញែកភ្លេង** — Demucs បំបែក vocals / instrumental (ដូចផ្ទាំងទី១ នៃសាយ)\n"
        "2. **សម្អាតសំឡេង** — UVR ដកហ៊ឹស/កង្ហារ (DeNoise) និង echo/reverb (DeEcho-DeReverb)\n"
        "\n"
        "រត់ cell ពីលើចុះក្រោម។ cell ៦ នឹងបោះពុម្ព URL `https://xxxx.trycloudflare.com`\n"
        "— ចម្លងវាទៅកាត «ញែកភ្លេង · Demucs API» ក្នុងសាយ។\n"
        "\n"
        "> T4 ឥតគិតថ្លៃ ~១២ ម៉ោង/សប្តាហ៍ ហើយ session ដាច់ពេលអសកម្ម។ URL ថ្មីរាល់ដងដែលបើកឡើងវិញ។"
    ),
    markdown("## 1. ពិនិត្យ GPU\n\nបើមិនឃើញ `Tesla T4` → Runtime → Change runtime type → T4 GPU។"),
    code("!nvidia-smi -L"),
    markdown("## 2. តំឡើង (លើកដំបូង ~៣–៦ នាទី)"),
    code(
        "%%bash\n"
        "set -e\n"
        "pip install -q --upgrade pip\n"
        "pip install -q demucs \"audio-separator[gpu]\" fastapi \"uvicorn[standard]\" python-multipart\n"
        "apt-get -qq update && apt-get -qq install -y ffmpeg\n"
        "echo 'តំឡើងរួចរាល់'\n"
    ),
    markdown(
        "## 3. ម៉ូឌែលសម្អាតសំឡេងមានអ្វីខ្លះ\n\n"
        "ឈ្មោះម៉ូឌែលប្តូរតាមកំណែ — មើលបញ្ជីពិតជាមុនសិន។"
    ),
    code(
        "!audio-separator --list_models 2>/dev/null | grep -iE 'denoise|reverb|debleed' | head -20 || true"
    ),
    markdown(
        "## 4. សរសេរ service\n\n"
        "`%%writefile` សរសេរកូដទៅ `/content/service.py` — ដូចគ្នានឹង `tools/colab/service.py` ក្នុង repo។"
    ),
    code("%%writefile /content/service.py\n" + source),
    markdown(
        "## 5. បើក service\n\n"
        "ដាក់ `SERVICE_KEY` ជាពាក្យសម្ងាត់របស់អ្នក (កុំទុកទទេ បើបើកចេញអ៊ីនធឺណិត)។"
    ),
    code(
        "import os, time, requests\n"
        "\n"
        "os.environ['SERVICE_KEY'] = 'change-me-please'\n"
        "os.environ['DEMUCS_MODEL'] = 'htdemucs'\n"
        "\n"
        "!pkill -f 'uvicorn service:app' || true\n"
        "!cd /content && nohup env SERVICE_KEY=$SERVICE_KEY DEMUCS_MODEL=$DEMUCS_MODEL \\\n"
        "    uvicorn service:app --host 0.0.0.0 --port 8920 > /content/service.log 2>&1 &\n"
        "\n"
        "time.sleep(6)\n"
        "print(requests.get('http://127.0.0.1:8920/health', timeout=20).json())\n"
    ),
    markdown("## 6. បើក tunnel យក URL\n\nចម្លopy URL ខាងក្រោមទៅកាត «ញែកភ្លេង · Demucs API» ក្នុងសាយ។"),
    code(
        "!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared\n"
        "!chmod +x /usr/local/bin/cloudflared\n"
        "!pkill -f cloudflared || true\n"
        "!nohup cloudflared tunnel --url http://localhost:8920 > /content/tunnel.log 2>&1 &\n"
        "\n"
        "import re, time\n"
        "time.sleep(10)\n"
        "log = open('/content/tunnel.log').read()\n"
        "match = re.search(r'https://[-\\w]+\\.trycloudflare\\.com', log)\n"
        "print('URL :', match.group(0) if match else 'រកមិនឃើញ — មើល /content/tunnel.log')\n"
        "print('KEY :', os.environ.get('SERVICE_KEY', ''))\n"
    ),
    markdown("## 7. សាកល្បងញែកភ្លេង\n\nដាក់បទទៅ `/content/in/song.mp3` សិន។"),
    code(
        "!mkdir -p /content/in\n"
        "!cd /content && curl -sS -H \"Authorization: Bearer $SERVICE_KEY\" \\\n"
        "    -F \"audio=@/content/in/song.mp3\" http://127.0.0.1:8920/separate | head -c 600\n"
    ),
    markdown(
        "## 8. សម្អាត vocal stem (UVR)\n\n"
        "```\n"
        "task=denoise   → UVR-DeNoise.pth          (ហ៊ឹស, កង្ហារ, ខ្យល់)\n"
        "task=dereverb  → UVR-DeEcho-DeReverb.pth  (echo, សំឡេងរង្គោះរង្គើ)\n"
        "task=debleed   → RoFormer denoise/debleed (ភ្លេងលូកចូល)\n"
        "```\n\n"
        "ដាក់ path របស់ `vocals.wav` ពី cell ៧ ជំនួស `<job>`។"
    ),
    code(
        "!cd /content && curl -sS -H \"Authorization: Bearer $SERVICE_KEY\" \\\n"
        "    -F \"audio=@/content/stems/<job>/vocals.wav\" -F \"task=denoise\" \\\n"
        "    http://127.0.0.1:8920/enhance | head -c 400\n"
    ),
    markdown(
        "## ចំណាំ\n\n"
        "* Job នៅសាយឈប់នៅជំហានញែក → tunnel ឬ session បានបិទ; បើក cell ៥–៦ ម្តងទៀត ហើយ paste URL ថ្មី។\n"
        "* `/enhance` មិនទាន់ហៅដោយសាយ — ត្រៀមទុកសម្រាប់ជំហាន «សម្អាតជ្រៅ» (សាកដោយ curl បាន)។\n"
        "* Stem រក្សាក្នុង `/content/stems/<job>/` រហូត session ដាច់។\n"
        "* កុំបើក `SERVICE_KEY` ទទេលើ tunnel សាធារណៈ — អ្នកណាមាន URL នឹងប្រើ GPU របស់អ្នកបាន។"
    ),
]

notebook = {
    "cells": cells,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"provenance": [], "gpuType": "T4"},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

out = ROOT / "studio_t4.ipynb"
out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("wrote", out, "with", len(cells), "cells")
