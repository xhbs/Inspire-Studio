package com.inspirestudio.storage;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.common.ErrorCode;
import com.inspirestudio.dto.PersistenceDtos;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/** 又拍云 REST API 对象存储适配器。 */
@Slf4j
@Component
public class UpyunObjectStorageProviderAdapter implements ObjectStorageProviderAdapter {

    public static final String PROVIDER = "upyun";
    private static final String DEFAULT_ENDPOINT = "https://v0.api.upyun.com";
    private static final int CONNECT_TIMEOUT_MILLIS = 15_000;
    private static final int READ_TIMEOUT_MILLIS = 120_000;

    @Override
    public String provider() {
        return PROVIDER;
    }

    @Override
    public void validate(PersistenceDtos.ObjectStorageConfig config) {
        ObjectStorageUrlBuilder.requireText(config.accessKey(), "又拍云操作员");
        ObjectStorageUrlBuilder.requireText(config.secretKey(), "又拍云操作员密码");
        ObjectStorageUrlBuilder.requireText(config.bucket(), "又拍云服务名");
        ObjectStorageUrlBuilder.requireHttpUrl(config.publicBaseUrl(), "又拍云公开访问地址");
        validateEndpoint(endpoint(config));
    }

    @Override
    public String putObject(PersistenceDtos.ObjectStorageConfig config, String key, InputStream inputStream,
                            long contentLength, String mimeType) {
        validate(config);
        validateKey(key);
        HttpURLConnection connection = null;
        String path = "/" + config.bucket().trim() + "/" + ObjectStorageUrlBuilder.encodeKeyPath(key);
        try {
            String endpoint = endpoint(config).replaceAll("/+$", "");
            URL url = URI.create(endpoint + path).toURL();
            String date = DateTimeFormatter.RFC_1123_DATE_TIME.format(ZonedDateTime.now(ZoneOffset.UTC));
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MILLIS);
            connection.setReadTimeout(READ_TIMEOUT_MILLIS);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(contentLength);
            connection.setRequestProperty("Date", date);
            connection.setRequestProperty("Authorization", authorization(config.accessKey().trim(), config.secretKey(), "PUT", path, date, ""));
            connection.setRequestProperty("Content-Type", StringUtils.hasText(mimeType) ? mimeType : "application/octet-stream");
            try (var output = connection.getOutputStream()) {
                inputStream.transferTo(output);
            }
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK && status != HttpURLConnection.HTTP_CREATED
                    && status != HttpURLConnection.HTTP_NO_CONTENT) {
                String detail = responseDetail(connection);
                log.warn("又拍云上传失败: service={}, status={}, key={}", config.bucket(), status, key);
                throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR,
                        "上传又拍云失败（HTTP " + status + "）" + (StringUtils.hasText(detail) ? ": " + detail : ""));
            }
            return ObjectStorageUrlBuilder.buildPublicUrl(config.publicBaseUrl().trim(), key);
        } catch (BusinessException exception) {
            throw exception;
        } catch (Exception exception) {
            log.warn("又拍云上传请求失败: service={}, key={}", config.bucket(), key, exception);
            throw new BusinessException(ErrorCode.THIRD_PARTY_CALL_ERROR, "上传又拍云失败，请检查网络和服务配置");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static String authorization(String operator, String password, String method, String uri, String date) throws Exception {
        return authorization(operator, password, method, uri, date, "");
    }

    static String authorization(String operator, String password, String method, String uri, String date,
                                String contentMd5) throws Exception {
        byte[] passwordDigest = MessageDigest.getInstance("MD5").digest(password.getBytes(StandardCharsets.UTF_8));
        String passwordMd5 = java.util.HexFormat.of().formatHex(passwordDigest);
        Mac hmac = Mac.getInstance("HmacSHA1");
        hmac.init(new SecretKeySpec(passwordMd5.getBytes(StandardCharsets.UTF_8), "HmacSHA1"));
        String signatureInput = method + "&" + uri + "&" + date
                + (StringUtils.hasText(contentMd5) ? "&" + contentMd5 : "");
        String signature = Base64.getEncoder().encodeToString(hmac.doFinal(signatureInput.getBytes(StandardCharsets.UTF_8)));
        return "UPYUN " + operator + ":" + signature;
    }

    private String endpoint(PersistenceDtos.ObjectStorageConfig config) {
        return StringUtils.hasText(config.endpoint()) ? config.endpoint().trim() : DEFAULT_ENDPOINT;
    }

    private void validateKey(String key) {
        if (!StringUtils.hasText(key) || key.startsWith("/") || key.contains("\\")
                || java.util.Arrays.stream(key.split("/", -1)).anyMatch(segment -> segment.isEmpty() || ".".equals(segment) || "..".equals(segment))) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "又拍云对象路径不合法");
        }
    }

    private void validateEndpoint(String value) {
        try {
            URI uri = URI.create(value);
            boolean http = "http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme());
            if (!http || !StringUtils.hasText(uri.getHost()) || uri.getUserInfo() != null
                    || uri.getQuery() != null || uri.getFragment() != null
                    || (StringUtils.hasText(uri.getPath()) && !"/".equals(uri.getPath()))) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAM_INVALID,
                    "又拍云 API 地址必须是根路径的HTTP或HTTPS地址，例如 https://v0.api.upyun.com");
        }
    }

    private String responseDetail(HttpURLConnection connection) {
        try (InputStream error = connection.getErrorStream()) {
            if (error == null) return "";
            byte[] bytes = error.readNBytes(1024);
            return new String(bytes, StandardCharsets.UTF_8).replaceAll("[\\r\\n\\t]", " ").trim();
        } catch (IOException ignored) {
            return "";
        }
    }
}
