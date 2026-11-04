/** Public trust anchor for the managed Tantan ingress. The private key lives
 * only on that server. Scope this CA to its exact WSS endpoint: never install
 * it globally, learn it from an unauthenticated connection, or trust it for
 * another Gateway. Server certificates can renew under the same CA without
 * changing Connector configuration; a CA rotation requires a reviewed update.
 */
const TANTAN_ENDPOINT = "wss://11.158.199.29:49186/gateway/v1/peer";
const TANTAN_CA = `-----BEGIN CERTIFICATE-----
MIIDPjCCAiagAwIBAgIUf+s6TDExFwBFzp5vJe9y9ejkKpgwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaQ29kZXggR2F0ZXdheSBsb2NhbCBJREUgQ0EwHhcNMjYx
MTA0MDgyNjEwWhcNMzExMTAzMDgyNjEwWjAlMSMwIQYDVQQDDBpDb2RleCBHYXRl
d2F5IGxvY2FsIElERSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKA9BhtlQPvlSoZQ0jsNnobjn98Ku7k6VeamH+YRsywstAdfdRYLBo2wpO6yfk69
W3kgcRx+I8PmtJ7fI/cuXeLprFoNyKkBNpSWB/4VR7CwS6lE2iGvtCLVee4nAhmd
g/zAnkdAMBMC+okOQiOLBj2S6l/qpAlaJz/LgzmNH64C5pmzjTJvsmV/n7LCcWzJ
utq+Sbf7RZ0vbh8kgeKcHMsKmyWGfx44MUDcqqriKJB5jH8l9a/mLoiiien8vG0T
x1PeLG/Rt2xhv721Lc12JuTUC0YIUqwEJoi0opioPkcuoWqJ9EH6encJd7tZYSXI
scpQsFsAtR/Bjb2ADxXW/UUCAwEAAaNmMGQwHQYDVR0OBBYEFCRKVTJip/W1Dq+d
OMfligbE114LMB8GA1UdIwQYMBaAFCRKVTJip/W1Dq+dOMfligbE114LMBIGA1Ud
EwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IB
AQCM6mgWfBfMrTdboB4c40F081RKFBDg6a6dQ7hbmC5pxnVktxvLZDBnFC5mPBF6
T/ce16uA7RmFruNXdYviAM1FjjCQZdLhMmORByelu5RUQFMMPTUVtuyLhCRZYbwq
eJt1xWs7SJ6wRnF46aimqV/Ayb89XdIazqJUdNizlXyR4v3W8aZY7Jzl+IZqQ2hs
TKgRhlWOab9H1XMtk/NzpS3vWT3LWm68wEN6VjGpALFR0Gu41+f3IcncDEWbo+3o
e9PrRodT1DVy1iXhHPvJ8YDLE1zm49XpXxQaA8otXRTDzORwicwStB9sbWhYe4fB
mZWcfTqVFeK0eYPdVpnooeGe
-----END CERTIFICATE-----
`;

/** Explicit operator configuration wins, including an empty/invalid CA: a bad
 * override must fail TLS verification rather than silently use another trust
 * source. Unknown endpoints retain Node's default trust. TLS itself still
 * verifies the certificate chain, validity period and hostname/IP.
 */
export function peerCertificateAuthority(url: string, explicitCA?: Buffer): Buffer | undefined {
  if (explicitCA !== undefined) return explicitCA;
  return new URL(url).href === TANTAN_ENDPOINT ? Buffer.from(TANTAN_CA) : undefined;
}
