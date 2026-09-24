# ញែកភ្លេងដោយ Demucs លើទូរស័ព្ទ (Termux) → គេហទំព័រ

គេហទំព័រ (backend នៅ cloud) ត្រូវការម៉ាស៊ីនញែកភ្លេងដើម្បីញែក **សំឡេងនិយាយ** ចេញពី
**ភ្លេង/សំឡេងផ្ទៃខាងក្រោយ** មុនពេលបញ្ចូលសំឡេងខ្មែរ។ អ្នកអាចប្រើ *ទូរស័ព្ទរបស់អ្នក*
ជាម៉ាស៊ីននោះ — ដោយរត់ Demucs ក្នុង **Termux** និងបើក tunnel ឲ្យគេហទំព័រភ្ជាប់បាន។

> ⚠️ **ហេតុអ្វីត្រូវការ tunnel?** គេហទំព័ររត់នៅលើ cloud។ `127.0.0.1:8000` ក្នុងទូរស័ព្ទ
> គឺ *ខាងក្នុងទូរស័ព្ទតែប៉ុណ្ណោះ* — cloud មើលមិនឃើញទេ។ ដូច្នេះត្រូវបើក URL សាធារណៈ
> (`https://…`) ដែលបញ្ជូនចូលមក port 8000 របស់ទូរស័ព្ទ។

---

## ជម្រើសខ្លី — បើកលើម៉ាស៊ីនតែមួយនឹងគេហទំព័រ (គ្មាន tunnel)

បើ backend នៃគេហទំព័ររត់លើម៉ាស៊ីនរបស់អ្នក (ឧ. workspace នេះ) វាហៅ
`http://127.0.0.1:8000` បានផ្ទាល់ — **មិនត្រូវការ tunnel ទេ**៖

```bash
sh ./tools/demucs-termux/run-local.sh          # បើក API នៅ 127.0.0.1:8000
```

រួចដាក់ `http://127.0.0.1:8000` ក្នុងកាត «ញែកភ្លេង · Demucs API» (ឬកំណត់តាម env៖
`AUDIO_SEPARATION_PROVIDER=demucs_api` និង `AUDIO_SEPARATOR_URL=http://127.0.0.1:8000`)។

* ស្គ្រីបនេះប្រើ venv ដែលមាន demucs រួច បើមិនមាន វាបង្កើត `.venv-demucs` ហើយដំឡើង
  (ទាញ torch ~200 MB — ចំណាយពេលតែម្តង)។ បើកនៅ `127.0.0.1` តាម default ដើម្បីកុំឲ្យ
  អ្នកផ្សេងក្នុង Wi-Fi តែមួយហៅបាន — ប្តូរដោយ `DEMUCS_HOST=0.0.0.0` បើត្រូវការ។
* ត្រូវទុក terminal នោះបើកចោល — បិទ = ការញែកភ្លេងឈប់ (គ្មានការជំនួសដោយ FFmpeg ទេ)។
* លើ CPU ខ្សោយ វាយឺតខ្លាំង៖ សាកល្បងក្នុង workspace នេះ សំឡេង ៤ វិនាទី ចំណាយ ~៨០ វិនាទី
  (ប្រហែល ២០ ដងនៃរយៈពេលសំឡេង)។ ដូច្នេះវីដេអូវែងគួរប្រើម៉ាស៊ីនខ្លាំងជាង។
* បើចង់ឲ្យ **ទូរស័ព្ទ** ជាអ្នកញែកវិញ សូមធ្វើតាមជំហានខាងក្រោម (ត្រូវការ tunnel)។

---

## ជំហាន ១ — បើក Demucs API លើទូរស័ព្ទ

> ⛔ **កុំដំឡើងក្នុង Termux ដើម។** វានឹងដួលរាល់ដង ព្រោះ pip ត្រូវសង់ `pydantic-core`
> (ត្រូវការ Rust ដែលមិនស្គាល់ target របស់ Android) ហើយ `torch` ក៏គ្មាន wheel សម្រាប់ Android៖
>
> ```
> Rust not found ... Target triple not supported by rustup: aarch64-unknown-linux-android
> ERROR: Failed to build 'pydantic-core' when installing build dependencies
> ```
>
> **ធ្វើតាមវិធីនេះវិញ** — ប្រើ Ubuntu ក្នុង `proot-distro` (មាន glibc ពេញ)៖
>
> ```bash
> pkg install -y proot-distro
> proot-distro install ubuntu
> proot-distro login ubuntu
> ```
>
> រួចវាយបញ្ជា *ក្នុង Ubuntu* ម្តងទៀត៖
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/demucs-termux/phone-start.sh | sh
> ```
>
> `phone-start.sh` ដឹងរឿងនេះហើយ៖ បើអ្នកវាយវាក្នុង Termux ដើម វានឹង
> **ចូល Ubuntu ជំនួសអ្នកដោយស្វ័យប្រវត្តិ** (បើ proot-distro + ubuntu ត្រូវបានដំឡើង)។

បើអ្នកមាន API ដំណើរការរួចហើយ រំលងជំហាននេះ ហើយទៅ **ជំហាន ២** តែម្តង។

```bash
# (ក្នុង Ubuntu នៃ proot) — បើក API + tunnel ដោយបញ្ជាតែមួយ
sh phone-start.sh
termux-wake-lock              # កុំឲ្យ Android កាត់ CPU ពេលញែកភ្លេង

# ជម្រើស A: API របស់អ្នកមានស្រាប់ (ឧ. ស្គ្រីបរបស់អ្នក) — គ្រាន់តែបើកវា
# ជម្រើស B: ប្រើ API ដែលភ្ជាប់មកជាមួយ repo នេះ (contract ច្បាស់ ១០០%)
sh install-demucs.sh                                        # ដំឡើង demucs + បណ្ណាល័យ API
DEMUCS_API_KEY='ដាក់-key-ផ្ទាល់ខ្លួន' python demucs_api.py     # បើកនៅ port 8000
```

ពិនិត្យថាដំណើរការ (terminal មួយទៀត)៖

```bash
curl -s http://127.0.0.1:8000/
# {"status":"ok","service":"Demucs API", ...}
```

> **កុំប្រើ `pip install -r requirements.txt` តែម្នាក់ឯង។** `demucs` ប្រកាសតម្រូវការ
> `lameenc` (សម្រាប់សរសេរ MP3) ដែលគ្មាន wheel លើ Android/arm ដូច្នេះ pip ដួលទាំងស្រុង៖
>
> ```
> ERROR: Cannot install -r requirements.txt because these package versions
> have conflicting dependencies ... demucs depends on lameenc>=1.2
> ... no matching distributions available for your environment: lameenc
> ```
>
> ស្គ្រីប `install-demucs.sh` ដោះបញ្ហានេះ ៖ សាកល្បងតាមធម្មតាមុន បើដួល — ដំឡើង demucs
> ដោយ `--no-deps` រួចដំឡើងបណ្ណាល័យពិតដែលវាត្រូវការ (torch, torchaudio, einops, ...)
> ដោយឆ្លងកាត់ lameenc។ API នេះសរសេរតែ WAV ដូច្នេះ MP3 មិនចាំបាច់ទេ។
>
> បើ **torch** ខ្លួនឯងនៅតែដំឡើងមិនចេញលើ Android សូមបើក API ក្នង
> `proot-distro ubuntu` (ជំហាន ២ ជម្រើស B) ឬប្រើកុំព្យូទ័រ/VPS វិញ។

## ជំហាន ២ — បើក tunnel (URL សាធារណៈ)

**ជម្រើស A — SSH (មិនត្រូវដំឡើងអ្វីបន្ថែម)។** Termux គ្មាន `cloudflared` ដូច្នេះប្រើ `openssh`៖

```bash
ssh -R 80:localhost:8000 nokey@localhost.run
```

វានឹងបោះពុម្ព URL ដូច `https://xxxxxxxx.lhr.life`។ **ចម្លង URL នោះ។**
(ជម្រើសផ្សេងទៀត៖ `ssh -R 80:localhost:8000 serveo.net` ឬ
`ssh -p 443 -R0:localhost:8000 a.pinggy.io`។)

**ជម្រើស B — cloudflared (ស្ថិតស្ថេរជាងលើ 4G)។** ដំឡើង binary ក្នុង `proot-distro ubuntu`
រួចឲ្យស្គ្រីបរក URL ឲ្យ៖

```bash
sh ./tools/demucs-termux/tunnel-cloudflared.sh
```

វាបិទ tunnel ចាស់, បើក cloudflared ដោយ `--protocol http2 --edge-ip-version 4`
(ជៀសវាង QUIC ដាច់ញាត់ លើបណ្តាញទូរស័ព្ទ) រួចបង្ហាញ URL ត្រង់ៗ — មិនត្រូវអាន log រកទេ។

* បើ tunnel បង្ហាញ Cloudflare **error 1033** នោះមានន័យថា cloudflared មិនកំពុងរត់
  (ត្រូវបើកវាឡើងវិញ) — URL នោះស្លាប់ហើយ។
* មិនប្រាកដថា URL មួយណាកំពុងរស់? បើក `sh tunnel-url.sh` — វាបង្ហាញ URL
  ចុងក្រោយក្នុង log រួចសាកវាពីខាងក្រៅឲ្យអ្នកឃើញផ្ទាល់។

* ទុក terminal នេះចោលបើកចុះ។ បិទ = គេហទំព័រភ្ជាប់មិនបាន។
* បើកឡើងវិញ **URL ថ្មី** — paste ថ្មីម្តងទៀតនៅជំហាន ៣ (វាលតែ ១ ប្រអប់)។

## ជំហាន ៣ — ប្រាប់គេហទំព័រ

1. ចូលគេហទំព័រដោយគណនី **Admin** (`OWNER_EMAILS`)។
2. ក្នុងផ្ទាំង **ស្ទូឌីយោ** បើកកាត **«ញែកភ្លេង · Demucs API»**។
3. បញ្ចូល URL ពីជំហាន ២ (បើ API របស់អ្នកមាន key សូមបញ្ចូលក្នុងវាល API Key)។
4. ចុច **«រក្សាទុក»** រួច **«សាកល្បងការតភ្ជាប់»**។

បើជោគជ័យ អ្នកនឹងឃើញឈ្មោះ service, រយៈពេល (ms) និងទំហំ stems ទាំងពីរ។
ការសាកល្បងនេះផ្ញើសំឡេង ៦ វិនាទីពិតៗ ទៅទូរស័ព្ទ — មិនមែន ping ទទេទេ។

## ជំហាន ៤ — បកប្រែវីដេអូ

ផ្ទុកវីដេអូខ្លី (១៥–៣០ វិនាទី) សាកល្បងជាមុន។ ក្នុង log នឹងឃើញ
`Uploading audio to https://…/separate`. បើភ្លេងដើមនៅតែរស់ក្រោមសំឡេងខ្មែរ → បានហើយ។

---

## បញ្ជីត្រួតពិនិត្យ (Checklist)

| ជំហាន | របៀបផ្ទៀងផ្ទាត់ |
|---|---|
| ១. API រត់ | `curl -s http://127.0.0.1:8000/` → `{"status":"ok","service":"Demucs API"}` |
| ២. tunnel បើក | SSH បង្ហាញ URL `https://…` |
| ៣. គេហទំព័រដឹង | កាត «ញែកភ្លេង» បង្ហាញ **ភ្ជាប់រួច** |
| ៤. សាកល្បងជោគជ័យ | ចុច «សាកល្បង» → បង្ហាញ vocals + instrumental ជា KB |
| ៥. ការងារពិត | បកប្រែវីដេអូ → ភ្លេងដើមលែងដាច់ |

## ពេលមានបញ្ហា

| រោគសញ្ញា | មូលហេតុ / ដំណោះស្រាយ |
|---|---|
| «fetch failed» ក្នុងការសាកល្បង | `tunnel បានបិទ` ឬ URL ថ្មី — បើក `sh tunnel-url.sh` វានឹងបង្ហាញ URL ដែលកំពុងរស់ រួច paste ថ្មី (URL ចាស់បាត់ពី DNS ទាំងស្រុង) |
| ការងារឈប់នៅជំហានញែកភ្លេង | គ្មាន Demucs ភ្ជាប់ទេ — បើក API + tunnel រួចពិនិត្យកាតជាមួយ «សាកល្បង» |
| បង្ហាញឈ្មោះ service តែបរាជ័យ | API មិនស្គាល់ endpoint នេះទេ — កំណត់ `AUDIO_SEPARATOR_PATH` ឬប្រើ `demucs_api.py` |
| `401 Invalid or missing API key` | ដាក់ key ដូចនៅក្នុង `DEMUCS_API_KEY` |
| យឺតខ្លាំង (ឬកម្តៅឡើង) | CPU ទូរស័ព្ទ៖ ប្រហែល ២–៦ ដងនៃរយៈពេលសំឡេង។ សាកល្បងវីដេអូខ្លី។ |
| ដំឡើងដួល៖ `Failed to build 'pydantic-core'` ឬ `Rust not found` | អ្នកកំពុងដំឡើងក្នុង **Termux ដើម** — មិនអាចទេ។ ចូល Ubuntu ជាមុន៖ `proot-distro login ubuntu` (ឬឲ្យ `phone-start.sh` ចូលឲ្យ) រួចដំឡើងម្តងទៀត |
| បាត់ពេលបិទអេក្រង់ | `termux-wake-lock` និងបិទ battery optimization សម្រាប់ Termux |
| វីដេអូឈប់នៅជំហានញែកភ្លេង | ការញែកភ្លេងជា **Demucs តែមួយ** — គ្មានការជំនួសដោយ FFmpeg DSP ទេ។ បើក API ឡើងវិញ រួចចាប់ផ្តើមការងារម្តងទៀត |

## ជំនួស environment (ជម្រើស)

ចង់កំណត់ពី server ដោយផ្ទាល់ក៏បាន (ជំនួសការប្រើកាតលើគេហទំព័រ)៖

| Key | តម្លៃ |
|---|---|
| `AUDIO_SEPARATION_PROVIDER` | `demucs_api` (ឬ `audio_separator`) |
| `AUDIO_SEPARATOR_URL` | URL សាធារណៈនៃ tunnel |
| `AUDIO_SEPARATOR_API_KEY` | key (បើមាន) |
| `AUDIO_SEPARATOR_MODEL` | ឈ្មោះម៉ូឌែល (ឧ. `htdemucs`) |
| `AUDIO_SEPARATOR_PATH` | path ពិសេស បើ API មិនប្រើ `/separate` |
| `AUDIO_SEPARATOR_FIELD` | ឈ្មោះ multipart field បើ API ទាមទារឈ្មោះពិសេស |
| `AUDIO_SEPARATOR_TIMEOUT_MS` | default `1800000` (៣០ នាទី) |

* URL ដែលរក្សាទុកលើគេហទំព័រ **ឈ្នះ** env តែមួយ — ដូច្នេះការផ្លាស់ tunnel មិនត្រូវការ redeploy។
* «ផ្តាច់» ក្នុងកាតនឹងលុបការកំណត់នោះ ហើយត្រឡប់ទៅ env វិញ។

## សុវត្ថិភាព

* បើ API ចេញអ៊ីនធឺណិត **ត្រូវដាក់ key ជានិច្ច** (`DEMUCS_API_KEY` ឬ `SEPARATOR_API_KEY`)
  ព្រោះអ្នកណាមាន URL នោះអាចប្រើ CPU ទូរស័ព្ទអ្នកបាន។
* Tunnel ជាបណ្តោះអាសន្ន៖ បិទ terminal = បិទទ្វារចូលទាំងស្រុង។
* គេហទំព័រលុប stems ក្នុង `DEMUCS_DATA_DIR` ស្វ័យប្រវត្តិក្រោយ `DEMUCS_TTL_HOURS`។
