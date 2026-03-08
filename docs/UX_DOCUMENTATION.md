# User Experience (UX) Document for EasyKonnect Application

## Introduction

This document outlines the user experience (UX) for a service marketplace platform, where users can book services, and service providers can list their services. The platform will cater to four primary roles: **Service Users**, **Service Providers**, **Admins**, and **Super-Admins**. These roles will have distinct functionalities and experiences depending on their purpose and access rights.

The document will explore two deployment options:
- **Single Mobile App (Role-Switching)**
- **Mobile App for Users with Web App for Providers**

Both deployment models ensure an intuitive experience for all users while maintaining flexibility for service providers.

---

## Platform Overview

The platform functions as a service marketplace where service providers can list various services (e.g., plumbing, electrical work, carpentry), and customers can request these services. The platform's business model is **commission-based**, taking a percentage from each service transaction.

### Key Features

- **Service Providers** can list, manage, and update their services.
- **Service Users** can browse services, request, and pay for services through the platform.
- **Admin and Super-Admin** manage users, monitor transactions, and ensure smooth platform operations.

---

## Roles Description

| Role | Description | Responsibilities |
|------|-------------|------------------|
| **Service User** | A customer who browses, requests, and pays for services. They can be anyone in need of services like plumbing, carpentry, etc. | Browse services, Request services, Make payments, Rate service providers, View booking history |
| **Service Provider** | A professional offering services like plumbing, mechanics, electrical work, etc., via the platform. | List services, Manage service offerings (availability, price, etc.), Accept/decline service requests, Get paid for completed jobs |
| **Admin** | A platform operator who manages the overall marketplace, approves service providers, manages disputes, and ensures platform health. | Manage users and service providers, Approve or reject listings, Handle disputes, Monitor transactions |
| **Super-Admin** | The highest-level user with full access and control over all aspects of the platform, including admins. | Manage platform-wide settings, Assign roles to Admins, Customize platform, Generate detailed reports |

---

## Platform User Experience Breakdown

### 1. Service User Experience

A Service User is a customer who browses services, requests them, and provides feedback through the platform.

#### Option 1: Single Mobile App for Service Users and Providers (Role Switching)

- **Login/Signup**: Service Users create an account using email or social logins (Google/Facebook). The app allows users to toggle between Service User and Service Provider roles.
- **Service Browsing**: Users can browse different services listed by various providers. Filters include category (e.g., plumbing, electrical), location, price, or rating.
- **Service Request**: Upon finding a desired service, Service Users can book it by choosing a provider and specifying details like location and preferred time. Users can also schedule services at a later date and receive notifications for the booking.
- **Payment**: Payments are processed through integrated payment gateways (Paystack/Stripe). The user sees the total amount, including the provider's cost and platform commission.
- **Ratings and Reviews**: After the service is completed, Service Users can rate the provider on various factors like service quality, professionalism, and timeliness.
- **Notifications**: Real-time notifications inform Service Users about booking confirmations, status updates, and payment receipts.

#### Option 2: Service Users on Mobile and Service Providers on Web

- Service Users use the Mobile App as described above.
- Service Providers access the platform via a Web App to manage their services, bookings, and payments.

---

### 2. Service Provider Experience

A Service Provider is a professional offering their services through the platform.

#### Option 1: Single Mobile App for Service Providers and Users

- **Login/Signup**: Service Providers log in through email or social media and must verify their identity by uploading documents (e.g., business license).
- **Service Listing**: Providers can list their services, including prices, location of service areas, and descriptions. Service Categories help users filter providers by the type of service.
- **Availability Management**: Providers can manage their availability through a built-in calendar, marking times they are free for bookings.
- **Service Request Management**: Providers receive notifications when a Service User requests their services. They can accept or decline the request.
- **Payment Processing**: After completing a service, providers receive payment via the platform. The platform takes a commission from the transaction.
- **Ratings and Reviews**: Providers can respond to reviews left by Service Users. This helps build trust and manage their reputation on the platform.

#### Option 2: Service Providers on Web

- **Service Listing & Management**: Service Providers use a Web Dashboard to list services and set prices and locations.
- **Booking Management**: Providers can manage bookings, set availability, and receive or reject requests based on their schedule.
- **Payment Management**: Providers can view detailed payment reports, including the commission deducted by the platform.
- **Profile and Review Management**: Providers can update their profiles, view reviews, and adjust their services based on customer feedback.

---

### 3. Admin Experience

An Admin is a user responsible for managing day-to-day operations of the platform, approving listings, handling disputes, and overseeing transactions.

- **Login and Dashboard**: Admins log into the admin panel, which provides a dashboard with an overview of the platform's performance (active users, service requests, transactions).
- **User and Service Provider Management**: Admins approve or reject Service Provider applications, ensuring that only verified providers can list services.
- **Service Monitoring**: Admins can view and manage all service listings, remove inappropriate content, and enforce platform policies.
- **Dispute Resolution**: Admins handle disputes between users and providers regarding cancellations, refunds, or poor-quality service.
- **Transaction Monitoring**: Admins monitor the financial transactions on the platform, ensuring providers are paid and that commissions are deducted correctly.
- **Reports Generation**: Admins can generate monthly or weekly reports on platform usage, earnings, active users, and other KPIs.

---

### 4. Super-Admin Experience

The Super-Admin has the highest level of control over the platform, managing all Admins and platform-wide settings.

- **Master Dashboard**: Super-Admins have access to a global dashboard showing all platform activity, including detailed financials, user statistics, and service performance.
- **User Role Management**: Super-Admins can create, edit, and deactivate Admin roles, granting different levels of access to platform features.
- **Platform Customization**: Super-Admins can configure platform-wide settings such as service categories, payment policies, and commission structures.
- **Full Access to Reports**: Super-Admins can access detailed reports, including the performance of service providers, financial transactions, and platform health.
- **Security and Compliance**: Super-Admins ensure platform security by monitoring user behavior, handling security settings, and making sure the platform complies with data privacy regulations.

---

## Other Platform Features

| Feature | Description |
|---------|-------------|
| **Notifications** | Real-time notifications for all users keep them informed about service bookings, requests, payments, and status updates. |
| **Geolocation** | Service Providers must input their location so that Service Users can search for providers near them. |
| **Identity Verification** | To ensure trust, Service Providers are required to upload proof of identity (e.g., government-issued ID, business license) for verification before their services go live. |
| **Payment Integration** | The platform integrates with Paystack or Stripe to handle all payments, ensuring security and ease of use for both Service Users and Providers. Commission Handling: The platform automatically deducts its commission from each payment. |
| **Service History** | Both Service Users and Providers can view their service history on their profiles, which helps build trust and provides insight into performance. |
| **Admin Analytics** | Admins can access real-time analytics of service usage, payments, and active users, allowing them to make informed decisions about platform improvements. |

---

## Payment and Commission Model

The platform operates on a commission-based model, where the platform takes a percentage from each transaction between Service Users and Providers.

### Payment Flow

1. Service Users make a payment via the platform for services rendered.
2. The platform deducts a fixed commission (e.g., 10%) from the total price.
3. The remaining amount is transferred to the Service Provider's account.

### Payment Options

- Credit/debit cards
- Mobile payments
- Bank transfers

### Commission Tracking

Both the Service User and Provider are informed of the commission structure. Service Users see the total price including commission, and Service Providers are shown the amount they will receive after the commission is deducted.

---

## Conclusion

The marketplace platform is designed with a clear focus on user-centric features, ensuring a seamless experience for Service Users, Service Providers, Admins, and Super-Admins. The platform supports two deployment models, making it flexible for different use cases. It provides critical features such as service listings, real-time notifications, secure payments, and comprehensive user management, which are necessary for building trust and efficiency within the platform.

This document details the complete user journey and platform features to ensure that the design and development process is aligned with user needs and business goals.
