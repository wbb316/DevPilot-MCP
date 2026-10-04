package com.example;

/** Minimal service; {@link #lengthOfTitle(User)} carries a known NPE bug. */
public class UserService {

    public String greet(String name) {
        return "Hello, " + name + "!";
    }

    /** Returns the length of the user's title. */
    public int lengthOfTitle(User user) {
        // BUG: no null check on user, and no null check on getTitle().
        return user.getTitle().length();
    }
}
