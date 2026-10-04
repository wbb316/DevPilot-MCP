package com.example;

/** Small entry point used by the fixture smoke test. */
public final class App {

    private App() {
    }

    public static void main(String[] args) {
        UserService service = new UserService();
        User user = new User("Ada Lovelace", "Countess of Computing");
        System.out.println(service.greet(user.getName()));
        System.out.println("title length: " + service.lengthOfTitle(user));
    }
}
