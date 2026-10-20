package com.inspirestudio.storage;

import com.inspirestudio.common.BusinessException;
import com.inspirestudio.dto.PersistenceDtos;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class UpyunObjectStorageProviderAdapterTest {

    @Test
    void shouldMatchUpyunDocumentedAuthorizationSignature() throws Exception {
        String authorization = UpyunObjectStorageProviderAdapter.authorization(
                "operator123", "password123", "PUT", "/upyun-temp/demo.jpg",
                "Wed, 09 Nov 2016 14:26:58 GMT", "7ac66c0f148de9519b8bd264312c4d64");

        Assertions.assertEquals("UPYUN operator123:YUaAZX+WNAcJdNGHS5SBlITME5A=", authorization);
    }

    @Test
    void shouldRequireUpyunOperatorPasswordServiceAndPublicDomain() {
        UpyunObjectStorageProviderAdapter adapter = new UpyunObjectStorageProviderAdapter();
        PersistenceDtos.ObjectStorageConfig config = new PersistenceDtos.ObjectStorageConfig(
                "upyun", "operator", "password", "ai-video-lemon", "", "https://v0.api.upyun.com",
                "inspire-studio", "", "upyun-storage", "又拍云", "", false);

        BusinessException missingDomain = Assertions.assertThrows(BusinessException.class, () -> adapter.validate(config));
        Assertions.assertTrue(missingDomain.getMessage().contains("公开访问地址"));

        PersistenceDtos.ObjectStorageConfig ready = new PersistenceDtos.ObjectStorageConfig(
                "upyun", "operator", "password", "ai-video-lemon", "", "https://v0.api.upyun.com",
                "inspire-studio", "https://ai-video.sosour.top", "upyun-storage", "又拍云", "", false);
        Assertions.assertDoesNotThrow(() -> adapter.validate(ready));
    }
}
