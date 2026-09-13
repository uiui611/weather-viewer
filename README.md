# GPV Weather Atlas

RustFS の `weather/noaa-gfs/YYYYMMDDHH.zarr` と `weather/forecast/YYYYMMDDHH.zarr` に
保存された NOAA/NCEP GFS 0.25° Zarr v2 を、
日本周辺の国土地理院地図上に表示する Bun + TypeScript アプリです。

## 表示方法と投影

GFS は緯度・経度による規則格子ですが、地理院タイルは Web Mercator です。
本アプリは Zarr の格子を単純な画像として重ねず、各格子セルの緯度・経度境界を
Leaflet の地図座標へ変換してから Canvas に描画します。表示範囲は 20–50°N、
118–155°E で、通信量を抑えるため既定では 0.5°間隔に間引いています。

左右の矢印キーで予報時刻、上下の矢印キーで同じ系列内のモデル初期時刻を変更できます。
初期時刻を変更した場合は同じ予報時間を維持し、存在しなければ最も近い予報時間を選択します。
地図の移動にはマウスまたはタッチ操作を使用します。
気象要素は選択肢に表示される `Alt+1`～`Alt+9` でも切り替えられます。

海面更正気圧は 990–1020 hPa の範囲で、1005 hPa からの差を強調した高コントラスト表示です。

背景地図には国土地理院の[標準地図タイル](https://maps.gsi.go.jp/development/ichiran.html)を使用し、表示画面内に出典を常時表示します。
ズームレベル5～8の小縮尺タイルに関係する GEBCO、海上保安庁、NIMA VMAP0 の出典も
フッターへ記載しています。

## ローカル実行

必要な環境変数を設定してから実行します。認証情報は `.env` やリポジトリへ保存しないでください。

```sh
bun install --frozen-lockfile
S3_ENDPOINT_URL=http://127.0.0.1:19000 \
S3_BUCKET=weather \
S3_PREFIXES=noaa-gfs,forecast \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
bun run dev
```

インデックスは `http://localhost:3000/weather-viewer`、気象地図は
`http://localhost:3000/weather-viewer/map`、ヘルスチェックは `/weather-viewer/healthz` です。

気象地図の選択状態は `collection`（データ系列）と `variable`（気象要素）の
クエリパラメータへ反映されるため、そのまま共有用リンクとして利用できます。

## コンテナと Kubernetes

```sh
docker build -t ubuntu.home.arpa/weather-zarr-viewer:0.1.4 .
docker push ubuntu.home.arpa/weather-zarr-viewer:0.1.4
kubectl apply --dry-run=client -f weather-viewer.yaml
kubectl apply -f weather-viewer.yaml
```

外部 Nginx から公開する場合は URL prefix を削除せず転送します。

```nginx
upstream weather_zarr_viewer {
    server 192.168.101.11:30810;
    server 192.168.101.12:30810;
    server 192.168.101.13:30810;
}

location /weather-viewer/ {
    proxy_pass http://weather_zarr_viewer;
}
```

## API

- `GET /weather-viewer/api/catalog`: 設定した各系列から `_SUCCESS` がある Zarr と変数・予報時刻を列挙
- `GET /weather-viewer/api/grid`: 指定した変数・時刻の日本周辺格子を返却
- `GET /weather-viewer/healthz`: プロセスのヘルスチェック

RustFS のアクセスキーはサーバー内だけで使用され、API やブラウザには返しません。
