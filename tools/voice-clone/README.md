# Voice clone — សំឡេងខ្មែរ ដោយសំឡេងដើម

បកប្រែរួច តែសំឡេងនៅជាសំឡេង TTS ធម្មតា។ ឧបករណ៍នេះបម្លែងសំឡេងនោះទៅជា
**សំឡេងរបស់អ្នកច្រៀងដើម** ដោយ zero-shot voice conversion (Seed-VC)៖
ខ្លឹមសារ (ពាក្យខ្មែរ) នៅដដែល តែ timbre មកពីសំឡេងដើម។ គ្មានការបង្ហាត់ គ្មានគណនី។

## ហេតុអ្វីមិន 100%

- **ពាក្យផ្សេង** — ខ្មែរ និងភាសាដើមមានសំឡេងខុសគ្នា ដូច្នេះវាមិនអាចដូចគ្នា ១០០% បានទេ។
- **timbre** — ដូចដើម (នេះជាអ្វីដែលឧបករណ៍នេះផ្តល់)។
- **accent និងចង្វាក់** — មកពីសំឡេងខ្មែរដែលបញ្ចេញពាក្យ (edge/google TTS)។

## ទាញយកឯកសារពី studio

ក្នុងកាត «បកប្រែជាខ្មែរ» មាន ៣ ឯកសារ៖

| ឯកសារ | សម្រាប់ |
|---|---|
| សំឡេង (`stem=vocals`) | `REF` — សំឡេងដើម ជាគំរូ timbre |
| សំឡេងខ្មែរ ឥតភ្លេង (`stem=khmer-speech`) | `SPEECH` — ពាក្យខ្មែរសុទ្ធ |
| ភ្លេង (`stem=music`) | `MUSIC` — លាយត្រឡប់ (ស្រេចចិត្ត) |

## រត់ (Colab ឬ Kaggle)

**វិធីងាយបំផុត — ដាក់តែ id របស់ job៖**

```python
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/voice-clone.sh | JOB='dub_mvtsfaxy_rqpq' sh
```

ស្គ្រីបបង្កើតលីងទាំង ៣ ដោយខ្លួនឯង (`REF`=`stem=vocals`, `SPEECH`=`stem=khmer-speech`,
`MUSIC`=`stem=music`) ហើយបង្ហាញវាមុនពេលទាញយក។

**វិធីដាក់លីងដោយខ្លួនឯង៖**

```python
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/voice-clone.sh | \
  REF='https://sal-juma.onrender.com/api/jobs/dub_mvtsfaxy_rqpq/download?stem=vocals' \
  SPEECH='https://sal-juma.onrender.com/api/jobs/dub_mvtsfaxy_rqpq/download?stem=khmer-speech' \
  MUSIC='https://sal-juma.onrender.com/api/jobs/dub_mvtsfaxy_rqpq/download?stem=music' sh
```

- **រក id យ៉ាងណា៖** ក្នុងកាត «បកប្រែជាខ្មែរ» ចុចឲ្យយូរ (ឬ hover) លើប៊ូតុងទាញយក →
  `Copy link` → ឃើញ `/api/jobs/<id>/download`។ **មិនត្រូវទុក `<id>` ដូចអក្សរទេ** —
  បើទុក ស្គ្រីបនឹងប្រាប់ថាលីងនៅមាន `<...>`។
- 404 = id ខុស ឬ job ចាស់មុនពេលបន្ថែមឯកសារនេះ → បង្កើតបទខ្មែរឡើងវិញ។
- `BASE` ប្តូរ origin (លំនាំដើម `https://sal-juma.onrender.com`)។
- `MODE=space` (លំនាំដើម) ប្រើ GPU ឥតគិតថ្លៃរបស់ Hugging Face — មិនត្រូវការ GPU ក្នុង notebook។
- `MODE=local` តំឡើង Seed-VC ក្នុង notebook (ត្រូវ GPU, លឿន និងគ្មានជួរ)។
- `OUT=...` កំណត់ទីតាំងឯកសារលទ្ធផល។

## ដែនកំណត់

- ផ្នែកនីមួយៗ (២០ វិនាទី) បម្លែងដោយឡែក ដូច្នេះសំឡេងអាចខុសគ្នាតិចៗរវាងផ្នែក។
- បើផ្នែកណាមួយបរាជ័យ វាប្រើសំឡេងខ្មែរដើមជំនួស ដើម្បីកុំឲ្យបាត់ពាក្យ។
- គុណភាពខ្ពស់ជាង៖ `MODE=local` + `--diffusion-steps 50` (កែក្នុងស្គ្រីប)។

## បន្ទាត់តែមួយ (ណែនាំ)

ក្នុង cell របស់ Google Colab (Runtime → Change runtime type → T4 GPU) បន្ទាប់ពី upload សំឡេង៖

```bash
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/colab-start.sh | sh
```

ជ្រើសឯកសារ/អ្នកច្រៀងដោយខ្លួនឯង៖

```bash
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/voice-clone/colab-start.sh \
  | AUDIO=/content/khmer.wav SINGER="Taylor Swift" STEPS=200 sh
```

វាពិនិត្យឯកសារ និងឈ្មោះអ្នកច្រៀងជាមុន (បើវាយខុស វាឈប់ភ្លាម មិនចំណាយ ៦ នាទីតំឡើង) រួចតំឡើង library,
ទាញ weights ~៥ GB ម្តងគត់, បម្លែង, និងបង្កើត MP3 នៅ `/content/<ឈ្មោះ>_<អ្នកច្រៀង>.mp3`។
អថេរ៖ `AUDIO` · `SINGER` · `PITCH` · `KEY_SHIFT` · `STEPS` · `OUT` · `SKIP_INSTALL=1` · `CHECK_ONLY=1`។

## ឥតគិតថ្លៃ ឥតកំណត់ចំនួនដង៖ Google Colab (Amphion DiffWaveNetSVC)

`lucataco/singing_voice_conversion` ជា Cog wrapper របស់ **Amphion DiffWaveNetSVC**។ Repo របស់ HF Space
`amphion/singing_voice_conversion` មានទាំង code និង weights ដូច្នេះ Notebook នេះទាញយកវាមករត់លើ GPU
ឥតគិតថ្លៃរបស់ Colab — គ្មាន API key គ្មានការគិតលុយតាមដង។

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/kitreaksa78-debug/Sal/blob/main/tools/voice-clone/colab-amphion-svc.ipynb)

លំដាប់៖ Runtime → T4 GPU → cell ១ (ដំឡើង) → cell ២ (ទាញ weights ~៥ GB) → cell ៣ (បម្លែង) → cell ៤ (ទាញយក MP3)។

**សំខាន់៖** model នេះបម្លែងតែ timbre — វាមិនបកប្រែភាសាទេ។ ដូច្នេះយក stem `khmer-speech`
(សំឡេងខ្មែរឥតភ្លេង) ពីបទដែលបកប្រែលើ site មកបម្លែងនៅទីនេះ រួចលាយជាមួយភ្លេងវិញ។
