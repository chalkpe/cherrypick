#!/bin/bash
mkdir -p certificates
new_root_ca=

# rootCA
# 既にあれば作り直さない (作り直したら、それで署名する各ドメインの証明書も作り直す)
if [ ! -f certificates/rootCA.crt ]; then
  openssl genrsa -des3 \
    -passout pass:rootCA \
    -out certificates/rootCA.key 4096
  openssl req -x509 -new -nodes -batch \
    -key certificates/rootCA.key \
    -sha256 \
    -days 1024 \
    -passin pass:rootCA \
    -out certificates/rootCA.crt
  new_root_ca=1
fi

# domain
function generate_certificate {
  if [ -n "$new_root_ca" ] || [ ! -f certificates/$1.crt ]; then
    openssl req -new -newkey rsa:2048 -sha256 -nodes \
      -keyout certificates/$1.key \
      -subj "/CN=$1/emailAddress=admin@$1/C=JP/ST=/L=/O=CherryPick Tester/OU=Some Unit" \
      -out certificates/$1.csr
    openssl x509 -req -sha256 \
      -in certificates/$1.csr \
      -CA certificates/rootCA.crt \
      -CAkey certificates/rootCA.key \
      -CAcreateserial \
      -passin pass:rootCA \
      -out certificates/$1.crt \
      -days 500
  fi
}

function generate {
  generate_certificate $1
  if [ ! -f .config/docker.env ]; then cp .config/example.docker.env .config/docker.env; fi
  if [ ! -f .config/$1.conf ]; then sed "s/\${HOST}/$1/g" .config/example.conf > .config/$1.conf; fi
  if [ ! -f .config/$1.default.yml ]; then sed "s/\${HOST}/$1/g" .config/example.default.yml > .config/$1.default.yml; fi
}

generate a.test
generate b.test
# 과거 기록 위조를 시험하는 가짜 그룹 소유 서버. tester가 이 이름으로 HTTPS를 연다
generate_certificate fake.test

# 通話は a.test だけで使えるようにする (LiveKit は compose.a.yml の livekit.a.test、鍵もそこと揃える)。
# b.test は通話に対応していないサーバーとして残す。既にある設定にも、voiceCall が無ければ足す
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const yaml = require("js-yaml");
const config = yaml.load(fs.readFileSync(file, "utf8"));
if (config.voiceCall == null) {
  config.voiceCall = {
    livekit: {
      internalUrl: "http://livekit.a.test:7880",
      apiKey: "cherrypick",
      apiSecret: "test-federation-livekit-secret-0123456789",
    },
  };
  fs.writeFileSync(file, yaml.dump(config));
}
' .config/a.test.default.yml
