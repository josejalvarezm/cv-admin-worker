# Cloudflare credentials are read from environment variables:
# CLOUDFLARE_API_TOKEN

variable "database_name" {
  description = "Name of the D1 staging database"
  type        = string
  default     = "cv-admin-staging"
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker"
  type        = string
  default     = "cv-admin-worker"
}

variable "zone_name" {
  description = "Cloudflare zone name (domain)"
  type        = string
  default     = "{YOUR_DOMAIN}"
}

variable "custom_domain" {
  description = "Custom domain for the Admin API"
  type        = string
  default     = "api.admin.{YOUR_DOMAIN}"
}

variable "environment" {
  description = "Environment (production, staging, development)"
  type        = string
  default     = "production"
}
