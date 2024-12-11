window.addEventListener('load', () => {
    fetch('/products')
      .then(response => response.json())
      .then(data => {
        const productList = document.getElementById('product-list');
        data.forEach(product => {
          const item = document.createElement('li');
          item.textContent = `${product.product_name} - 수량: ${product.quantity}`;
          productList.appendChild(item);
        });
      })
      .catch(error => console.error('Error:', error));
  });
  