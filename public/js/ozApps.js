// The OZ tarot family. One coin wallet works in all of them, so each app's
// coin page lists the others with a way to get them. Edit this list when an
// app is published: set `packageId` (Google Play id) and it becomes "다운받기".
// Keep this file identical across the OZ apps.
export const OZ_APPS = [
  { key: 'color-tarot',      name: 'OZ 컬러타로',     desc: '색으로 마음을 읽고, 향·차·원석으로 하루를 돌봐요', packageId: 'com.ozma.colortarot',      web: 'https://color.ozfortune.site' },
  { key: 'numerology-tarot', name: 'OZ 넘버스 타로',  desc: '생일 숫자로 보는 나의 성향과 궁합',               packageId: 'com.ozma.numerologytarot', web: 'https://numerology.ozfortune.site' },
  { key: 'rune-tarot',       name: 'OZ 룬타로',       desc: '룬 문자가 건네는 오늘의 메시지',                   packageId: null,                       web: 'https://rune.ozfortune.site' },
  { key: 'oshozen-tarot',    name: 'OZ 내면 명상 타로', desc: '감정을 나누면 카드가 말을 건네고, 명상으로 이어가요',                 packageId: null,                       web: 'https://oshozen.ozfortune.site' },
  { key: 'fact-tarot',       name: 'OZ 팩폭타로',     desc: '돌려 말하지 않는 솔직한 한마디',                   packageId: null,                       web: null },
];

export const playUrl = (packageId) => `https://play.google.com/store/apps/details?id=${packageId}`;
export const shortName = (key) => (OZ_APPS.find((a) => a.key === key)?.name || '').replace(/^OZ /, '');
