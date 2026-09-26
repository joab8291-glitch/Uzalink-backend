import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../lib/config.js";

const configured = Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
const client = configured ? new S3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT || undefined, forcePathStyle: env.S3_FORCE_PATH_STYLE === "true", credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! } }) : null;
export async function putPrivateObject(key: string, body: Buffer, contentType: string) {
  if (!client) throw new Error("Private storage is not configured");
  await client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
  return key;
}
export async function signedDownloadUrl(key: string, fileName: string, seconds: number, inline = false) {
  if (!client) throw new Error("Private storage is not configured");
  return getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${fileName.replace(/"/g, "")}"` }), { expiresIn: Math.min(seconds, 900) });
}
