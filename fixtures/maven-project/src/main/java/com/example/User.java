package com.example;

/** Plain data holder. */
public class User {

    private final String name;
    private final String title;

    public User(String name, String title) {
        this.name = name;
        this.title = title;
    }

    public String getName() {
        return name;
    }

    public String getTitle() {
        return title;
    }
}
