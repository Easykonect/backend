# EasyKonnect API - Quick Start for Frontend Developers

## 🚀 Getting Started

Your GraphQL API is live at:
```
https://backend-ehtm.onrender.com/api/graphql
```

### Test the API (GraphQL Playground)

Visit this URL in your browser to explore the API interactively:
```
https://backend-ehtm.onrender.com/api/graphql
```

**Note**: On Render's free tier, the first request after 15 minutes of inactivity takes ~30 seconds to wake up. Subsequent requests are fast.

---

## 📱 Frontend Integration Examples

### React/Next.js with Apollo Client

```bash
npm install @apollo/client graphql
```

```javascript
// lib/apollo-client.js
import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';

const httpLink = createHttpLink({
  uri: 'https://backend-ehtm.onrender.com/api/graphql',
});

const authLink = setContext((_, { headers }) => {
  const token = localStorage.getItem('accessToken');
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : "",
    }
  }
});

const client = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
});

export default client;
```

```javascript
// pages/_app.js (Next.js)
import { ApolloProvider } from '@apollo/client';
import client from '../lib/apollo-client';

function MyApp({ Component, pageProps }) {
  return (
    <ApolloProvider client={client}>
      <Component {...pageProps} />
    </ApolloProvider>
  );
}

export default MyApp;
```

```javascript
// Example: Register component
import { gql, useMutation } from '@apollo/client';

const REGISTER_USER = gql`
  mutation RegisterUser($input: RegisterInput!) {
    registerUser(input: $input) {
      success
      message
    }
  }
`;

function RegisterForm() {
  const [registerUser, { loading, error }] = useMutation(REGISTER_USER);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const { data } = await registerUser({
        variables: {
          input: {
            fullName: "John Doe",
            email: "john@example.com",
            password: "SecurePass123!",
            phoneNumber: "+2348012345678"
          }
        }
      });
      console.log(data.registerUser);
    } catch (err) {
      console.error(err.message);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Form fields */}
      <button type="submit" disabled={loading}>
        {loading ? 'Loading...' : 'Register'}
      </button>
      {error && <p>Error: {error.message}</p>}
    </form>
  );
}
```

---

### React Native with Apollo Client

```bash
npm install @apollo/client graphql
npm install @react-native-async-storage/async-storage
```

```javascript
// apolloClient.js
import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import AsyncStorage from '@react-native-async-storage/async-storage';

const httpLink = createHttpLink({
  uri: 'https://backend-ehtm.onrender.com/api/graphql',
});

const authLink = setContext(async (_, { headers }) => {
  const token = await AsyncStorage.getItem('accessToken');
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : "",
    }
  }
});

const client = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
});

export default client;
```

```javascript
// App.js
import { ApolloProvider } from '@apollo/client';
import client from './apolloClient';

export default function App() {
  return (
    <ApolloProvider client={client}>
      {/* Your app components */}
    </ApolloProvider>
  );
}
```

---

### Flutter with graphql_flutter

```yaml
# pubspec.yaml
dependencies:
  graphql_flutter: ^5.1.2
```

```dart
// lib/graphql_config.dart
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class GraphQLConfig {
  static final storage = FlutterSecureStorage();
  
  static HttpLink httpLink = HttpLink(
    'https://backend-ehtm.onrender.com/api/graphql',
  );

  static Future<AuthLink> authLink() async {
    final token = await storage.read(key: 'accessToken');
    return AuthLink(
      getToken: () async => token != null ? 'Bearer $token' : '',
    );
  }

  static Future<ValueNotifier<GraphQLClient>> initializeClient() async {
    final auth = await authLink();
    final link = auth.concat(httpLink);

    return ValueNotifier(
      GraphQLClient(
        link: link,
        cache: GraphQLCache(store: InMemoryStore()),
      ),
    );
  }
}
```

```dart
// lib/main.dart
import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'graphql_config.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final client = await GraphQLConfig.initializeClient();
  
  runApp(MyApp(client: client));
}

class MyApp extends StatelessWidget {
  final ValueNotifier<GraphQLClient> client;
  
  MyApp({required this.client});

  @override
  Widget build(BuildContext context) {
    return GraphQLProvider(
      client: client,
      child: MaterialApp(
        home: HomeScreen(),
      ),
    );
  }
}
```

```dart
// Example: Register mutation
const String registerMutation = r'''
  mutation RegisterUser($input: RegisterInput!) {
    registerUser(input: $input) {
      success
      message
    }
  }
''';

// In your widget
Mutation(
  options: MutationOptions(
    document: gql(registerMutation),
    onCompleted: (dynamic resultData) {
      print(resultData);
    },
  ),
  builder: (RunMutation runMutation, QueryResult? result) {
    return ElevatedButton(
      onPressed: () {
        runMutation({
          'input': {
            'fullName': 'John Doe',
            'email': 'john@example.com',
            'password': 'SecurePass123!',
            'phoneNumber': '+2348012345678',
          }
        });
      },
      child: Text('Register'),
    );
  },
);
```

---

### Simple Fetch (Any JavaScript framework)

```javascript
const GRAPHQL_ENDPOINT = 'https://backend-ehtm.onrender.com/api/graphql';

async function graphqlRequest(query, variables = {}, token = null) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` })
    },
    body: JSON.stringify({ query, variables })
  });
  
  const result = await response.json();
  
  if (result.errors) {
    throw new Error(result.errors[0].message);
  }
  
  return result.data;
}

// Example: Register
const registerMutation = `
  mutation RegisterUser($input: RegisterInput!) {
    registerUser(input: $input) {
      success
      message
    }
  }
`;

const variables = {
  input: {
    fullName: "John Doe",
    email: "john@example.com",
    password: "SecurePass123!",
    phoneNumber: "+2348012345678"
  }
};

const data = await graphqlRequest(registerMutation, variables);
console.log(data.registerUser);

// Example: Login
const loginMutation = `
  mutation LoginUser($input: LoginInput!) {
    loginUser(input: $input) {
      success
      message
      accessToken
      refreshToken
      user {
        id
        fullName
        email
      }
    }
  }
`;

const loginData = await graphqlRequest(loginMutation, {
  input: {
    email: "john@example.com",
    password: "SecurePass123!"
  }
});

// Store tokens
localStorage.setItem('accessToken', loginData.loginUser.accessToken);
localStorage.setItem('refreshToken', loginData.loginUser.refreshToken);

// Authenticated request example
const token = localStorage.getItem('accessToken');
const userData = await graphqlRequest(
  `query { me { id fullName email } }`,
  {},
  token
);
```

---

## 🔑 Authentication Flow

1. **Register** → User creates account
2. **Verify Email** → User enters OTP from email
3. **Login** → Receives `accessToken` and `refreshToken`
4. **Store tokens** in localStorage/AsyncStorage/Secure Storage
5. **Send accessToken** in Authorization header for protected requests
6. **Refresh token** when accessToken expires (use refreshToken)

---

## 📊 Available APIs

### Authentication
- ✅ `registerUser` - Create new account
- ✅ `verifyEmail` - Verify OTP
- ✅ `loginUser` - Login and get tokens
- ✅ `forgotPassword` - Request password reset
- ✅ `resetPassword` - Reset password with OTP
- ✅ `refreshAccessToken` - Get new access token

### Coming Soon
- Service Provider registration
- Services CRUD
- Bookings
- Payments
- Reviews

---

## 📖 Full Documentation

For detailed API documentation including all mutations, queries, request/response formats, and error codes, see:

👉 [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md)

---

## 🐛 Common Issues

### 1. **Slow first request (30+ seconds)**
This is normal on Render's free tier - the server "wakes up" after being idle.

**Solution**: Consider upgrading to Render's Starter plan ($7/month) for always-on servers.

### 2. **CORS errors**
The API should allow all origins. If you get CORS errors, let the backend team know.

### 3. **Token expired**
Use the `refreshAccessToken` mutation with your refresh token to get a new access token.

```javascript
const refreshMutation = `
  mutation RefreshToken($refreshToken: String!) {
    refreshAccessToken(refreshToken: $refreshToken) {
      success
      accessToken
    }
  }
`;
```

### 4. **GraphQL errors vs HTTP errors**
- HTTP 200 + `errors` array = GraphQL validation/business logic error
- HTTP 500 = Server error
- HTTP 401 = Unauthorized (invalid/expired token)

---

## 🆘 Support

For issues or questions, contact the backend team or check the repository:
- Repository: https://github.com/Easykonect/backend
- Issues: https://github.com/Easykonect/backend/issues

---

## 🔗 Useful Links

- **API Endpoint**: https://backend-ehtm.onrender.com/api/graphql
- **Apollo Sandbox**: https://backend-ehtm.onrender.com/api/graphql (interactive playground)
- **Full Integration Guide**: [FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md)
