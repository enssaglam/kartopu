# Kartopu — Temettü Takip

BIST ve global (ABD) temettü/hisse portföyünü tek yerde takip etmek için basit bir web uygulaması (PWA).
Mac veya Xcode gerekmez — Windows'tan yayına alıp iPhone'una "Ana Ekrana Ekle" ile native app gibi kurabilirsin.

## Özellikler

- **Portföy takibi** — BIST hisseleri ve global ETF/hisseler, adet + maliyet + güncel fiyat
- **Temettü takibi** — her ödemeyi kaydet, stopaj sonrası net tutar otomatik hesaplanır
- **Kartopu simülatörü** — yeniden yatırım varsayımıyla yıllara göre büyüme projeksiyonu
- **TRY/USD çift para birimi** — otomatik dönüşüm, canlı kur çekme (internet gerektirir)
- **Tamamen özel** — veriler sadece telefonunda saklanır (localStorage), hiçbir sunucuya gönderilmez
- **Yedekleme** — Ayarlar sekmesinden tüm verini .json olarak indirip başka cihaza taşıyabilirsin

## Yayına Alma (2 dakika, ücretsiz, Mac gerekmez)

### Adım 1: Netlify Drop'a git
1. Tarayıcında **https://app.netlify.com/drop** adresini aç (hesap açmana bile gerek yok)
2. `public/` klasörünü
   seçip sayfaya sürükle-bırak yap
3. Birkaç saniyede bir link üretilecek (örn. `https://random-isim-12345.netlify.app`)

### Adım 2: iPhone'una kur
1. iPhone'da **Safari** ile o linki aç (Chrome değil, Safari olmalı)
2. Alt ortadaki **Paylaş** butonuna dokun (kare + yukarı ok ikonu)
3. Aşağı kaydır, **"Ana Ekrana Ekle"** seçeneğine dokun
4. İsmi onayla, **"Ekle"** de

Artık ana ekranında "Kartopu" ikonu var — dokunduğunda tarayıcı çubuğu olmadan, tam ekran, native app gibi açılır.

### Kalıcı link istersen
Netlify Drop'taki geçici link birkaç gün sonra silinebilir. Kalıcı olması için:
1. Netlify Drop sayfasında ücretsiz hesap oluştur (email yeterli)
2. Aynı dosyaları tekrar sürükle-bırak yap, bu sefer hesabına kaydedilir
3. İstersen Site Settings'ten linki özelleştirebilirsin (örn. `kartopu-ahmet.netlify.app`)

## Verilerini Girme

1. **Portföy** sekmesinden sağ alttaki **+** ile pozisyonlarını ekle (BIST veya Global, adet, maliyet)
2. **Temettü** sekmesinden aldığın her ödemeyi kaydet — net tutar otomatik hesaplanır
3. **Ayarlar**'dan stopaj oranlarını (varsayılan %15/%15) ve USD/TRY kurunu kontrol et
4. **Kartopu** sekmesinde yeniden yatırım senaryonu otomatik oluşur, istersen varsayımları değiştir

## Önemli Notlar

- **Fiyatlar otomatik güncellenebilir** — Portföy ekranındaki “Fiyatları Güncelle” butonu BIST ve ABD fiyatlarını Netlify Function üzerinden alır. Veri gecikmeli olabilir.
- **Manuel fiyat yedeği** — otomatik veri alınamazsa pozisyonu düzenleyerek güncel fiyatı elle girebilirsin.
- **USD/TRY kuru** Ayarlar'dan "Canlı Kuru Çek" ile otomatik güncellenebiliyor (ücretsiz, resmi bir
  kaynaktan — frankfurter.app), internet bağlantısı gerektirir
- **Veri kaybı riski**: Tarayıcı verilerini/geçmişi temizlersen kayıtların silinir. Düzenli olarak
  Ayarlar > "Verileri Dışa Aktar" ile yedek al

## Dosya Yapısı

```
index.html      — Ana sayfa
app.js          — Tüm uygulama mantığı (hesaplamalar, ekranlar, form işlemleri)
styles.css      — Görsel tasarım
manifest.json   — PWA ayarları (isim, ikon, tema rengi)
sw.js           — Çevrimdışı çalışma desteği
icons/          — Uygulama ikonları
```

Arayüz için build adımı veya framework gerekmez. Otomatik fiyat güncellemesi için Netlify Function kullanıldığı için en sorunsuz yayın yöntemi GitHub + Netlify veya Netlify CLI'dır.


## Otomatik Fiyat Verisini Yayına Alma

Bu sürümde fiyat servisi bir **Netlify Function** kullanır. Bu nedenle yalnızca eski tip statik sürükle-bırak yerine şu iki yöntemden birini kullan:

1. **Önerilen:** projeyi GitHub’a koyup Netlify’a repository olarak bağla. `netlify.toml` fonksiyonu otomatik algılar.
2. **Alternatif:** Netlify CLI ile proje klasöründe `netlify deploy --prod` çalıştır.

Fiyat mimarisi: telefon → `/api/quotes` → Netlify Function → Yahoo Finance Chart verisi. Böylece tarayıcı CORS sorunu yaşamaz ve harici API anahtarı uygulamanın içine gömülmez.

Not: Yahoo Finance endpoint’i resmi geliştirici API’si değildir ve veri gecikmeli olabilir. Kişisel kullanım için pratik bir ücretsiz başlangıç çözümüdür. Ürün ticari/çok kullanıcılı hale gelirse lisanslı bir veri sağlayıcıya geçilmelidir.
