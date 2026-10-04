package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class UserServiceTest {

    private final UserService service = new UserService();

    @Test
    void greetUsesTheGivenName() {
        assertEquals("Hello, Ada!", service.greet("Ada"));
    }
}
