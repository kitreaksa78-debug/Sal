# NLLB-200 លើ Google Colab (បកប្រែវីដេអូ)

ការបកប្រែរបស់គេហទំព័រ KhmerDub AI ប្រើ **តែ NLLB-200** (`facebook/nllb-200-distilled-600M`)
ប៉ុណ្ណោះ។ ម៉ូឌែលនេះត្រូវការអង្គចងចាំ ~១,៥ GB ដូច្នេះវាមិនអាចរត់លើ Render free (៥១២ MB) បានទេ —
វារត់នៅលើ Colab ហើយគេហទំព័រផ្ញើអត្ថបទទៅវាតាម HTTP។

## របៀបបើក

1. បើក `nllb_colab.ipynb` ក្នុង Google Colab រួចជ្រើស
   `Runtime → Change runtime type → T4 GPU`។
2. រត់ cell ទាំង ៣ តាមលំដាប់។ cell ទី ២ បង្ហាញ **URL** និង **API Key**។
3. ចម្លង URL + Key ទៅកាត **«បកប្រែ · NLLB API»** ក្នុងផ្ទាំងស្ទូឌីយោ រួចចុច «រក្សាទុក និងសាកល្បង»។
   ជោគជ័យ = ឃើញ `NLLB Translation API · cuda`។

មិនចង់ប្រើ notebook? ក្នុង cell មួយ គ្រាន់តែ paste៖

```sh
!curl -fsSL https://raw.githubusercontent.com/kitreaksa78-debug/Sal/main/tools/nllb-colab/colab-start.sh | sh
```

## ឯកសារ

| ឯកសារ | តួនាទី |
| --- | --- |
| `nllb_api.py` | FastAPI service៖ `GET /` = ស្ថានភាព, `POST /translate` = បកប្រែបញ្ជីបន្ទាត់ |
| `colab-start.sh` | ដំឡើង + បើក API + tunnel + បង្ហាញ URL/Key (បញ្ជាតែមួយ) |
| `nllb_colab.ipynb` | Notebook ដដែលនោះសម្រាប់អ្នកចូលចិត្តចុចរត់ |

## Contract របស់ API

```http
GET /            -> {"status":"ok","service":"NLLB Translation API","model":"facebook/nllb-200-distilled-600M","device":"cuda","loaded":true}

POST /translate  -> {"segments":[{"id":"s1","khmer":"សួស្តី"}]}
body: {"lines":[{"id":"s1","text":"Hello"}], "src_lang":"eng_Latn", "tgt_lang":"khm_Khmr"}
```

ការផ្ទៀងផ្ទាត់សិទ្ធិ: ពេលកំណត់ `NLLB_API_KEY` រាល់ request ត្រូវផ្ញើ
`Authorization: Bearer <key>` ឬ `X-API-Key: <key>`។

## កំណត់ត្រា

NLLB ជាម៉ូឌែលបកប្រែប្រយោគ — វាមិនអនុវត្តតាមការណែនាំ (អារម្មណ៍, បញ្ជីពាក្យ, ប្រវែងតាមពេលវេលា)
ទេ។ នេះជាការសម្រេចចិត្ត៖ ម្ចាស់គេហទំព័រជ្រើសយកគុណភាព NLLB ធម្មតា
ជំនួសម៉ូឌែលដែលដើរតាមការណែនាំ។
