# Use the official Node.js image
FROM node:16

RUN apt-get update && apt-get install -y default-mysql-client

# Create and change to the app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

#Start the app
CMD ["node", "index.js"]
