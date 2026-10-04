# maven-project fixture

Maven + Java 17 project with one JUnit 5 test and a deliberate bug.

`UserService.lengthOfTitle(User)` dereferences `user.getTitle()` with no null
check, so it throws `NullPointerException` for a null user or null title.

Build: `mvn -q test`. Run: `mvn -q exec:java` is intentionally not configured —
use `mvn -q package` and `java -cp target/classes com.example.App`.
